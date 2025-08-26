// redis_exporter/log_watcher.js
const fs = require("fs");
const axios = require("axios");

let lastSize = 0; // track where we left off

async function checkRedisLogs(config) {
  const logFile = config.redis_log_file || "/var/log/redis/redis-server.log";
  const maxLogsPerBatch = config.max_logs_per_batch || 100; // cap per run

  try {
    const stats = fs.statSync(logFile);

    // if file rotated or truncated, reset
    if (stats.size < lastSize) {
      lastSize = 0;
    }

    // read only the new portion
    const stream = fs.createReadStream(logFile, {
      start: lastSize,
      end: stats.size,
      encoding: "utf8",
    });

    let buffer = "";
    stream.on("data", (chunk) => (buffer += chunk));

    stream.on("end", async () => {
      lastSize = stats.size;

      const lines = buffer.split("\n").filter((l) => l.trim());
      const errorLines = lines.filter((l) => /ERR|WARN/i.test(l));

      if (errorLines.length > 0) {
        // cap logs if too many
        const limitedErrors = errorLines.slice(-maxLogsPerBatch);

        const logs = limitedErrors.map((line) => ({
          source: "redis",
          level: /ERR/i.test(line) ? "error" : "warn",
          message: line,
          timestamp: new Date().toISOString(),
        }));

        try {
          await axios.post(config.receiver_url_logs, { logs });
          console.log(
            `?? Exported ${logs.length} Redis logs (capped at ${maxLogsPerBatch})`
          );
        } catch (err) {
          console.error("? Failed to send Redis logs:", err.message);
        }
      } else {
        console.log("?? No new Redis error logs found");
      }
    });
  } catch (err) {
    console.error("? Redis log watcher failed:", err.message);
  }
}

function startLogWatcher(config) {
  console.log(
    `? Redis log watcher started (interval: ${
      config.log_check_interval || 300
    } sec, max logs per batch: ${config.max_logs_per_batch || 100})`
  );

  setInterval(() => {
    checkRedisLogs(config);
  }, (config.log_check_interval || 300) * 1000); // default 5 min
}

module.exports = { startLogWatcher };
