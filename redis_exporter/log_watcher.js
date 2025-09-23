// redis_exporter/log_watcher.js
const fs = require("fs");
const axios = require("axios");
const os = require("os");
const moment = require("moment");

function getServerIP() {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const alias of iface) {
      if (alias.family === "IPv4" && !alias.internal) return alias.address;
    }
  }
  return "unknown_ip";
}

async function checkRedisLogs(config, app, ip, purpose) {
  const logFile = config.redis_log_file || "/var/log/redis/redis-server.log";
  const maxLogsPerBatch = config.max_logs_per_batch || 100;

  try {
    const data = fs.readFileSync(logFile, "utf8");
    const lines = data.split("\n").filter((l) => l.trim());
    const errorLines = lines.filter((l) => /ERR|WARN/i.test(l));

    if (errorLines.length === 0) {
      console.log("â„¹ No Redis error logs found");
      return;
    }

    // Take only last maxLogsPerBatch
    const limitedErrors = errorLines.slice(-maxLogsPerBatch);

    const logs = limitedErrors.map((line) => ({
      source: "redis",
      level: /ERR/i.test(line) ? "error" : "warn",
      message: line,
      timestamp: new Date().toISOString(),
    }));

    const timestamp = moment();
    const dateStr = timestamp.format("YYYY-MM-DD");
    const timeStr = timestamp.format("hh:mm:ssA");

    const payload = {
      app,
      ip,
      purpose,
      source: "redis_log_watcher",
      logs,
      timestamp: timestamp.toISOString(),
      file_path: `metrics_collector/${app}/${ip}/redis_logs/${dateStr}/${timeStr}.jsonl.gz`,
      log_file_path: `metrics_collector/${app}/${ip}/logs/redis/${dateStr}/${timeStr}.jsonl.gz`,
    };

    console.log({ payload });

    try {
      await axios.post(config.receiver_url_logs, payload);
      console.log(`âœ… Exported ${logs.length} Redis logs to ${config.receiver_url_logs}`);
    } catch (err) {
      console.error("âŒ Failed to send Redis logs:", err.message);
    }
  } catch (err) {
    console.error("âŒ Redis log watcher error:", err.message);
  }
}

function startLogWatcher(config) {
  console.log(
    `í ½íº€ Redis log watcher started (interval: ${config.log_check_interval || 300}s, max logs per batch: ${config.max_logs_per_batch || 100})`
  );

  const app = config.global?.app_name || "unknown_app";
  const purpose = config.global?.purpose || "";
  const ip = getServerIP();

  setInterval(() => {
    checkRedisLogs(config, app, ip, purpose);
  }, (config.log_check_interval || 300) * 1000);
}

module.exports = { startLogWatcher };
