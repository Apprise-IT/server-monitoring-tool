const fs = require('fs');
const axios = require('axios');

let lastSize = 0;

async function checkMongoLogs(config) {
  const logFile = config.mongo_log_file || '/var/log/mongodb/mongod.log';
  const maxLogsPerBatch = config.max_logs_per_batch || 100;

  try {
    const stats = fs.statSync(logFile);

    // Reset if rotated or truncated
    if (stats.size < lastSize) lastSize = 0;

    const stream = fs.createReadStream(logFile, { start: lastSize, end: stats.size, encoding: 'utf8' });
    let buffer = '';

    stream.on('data', chunk => buffer += chunk);

    stream.on('end', async () => {
      lastSize = stats.size;

      const lines = buffer.split('\n').filter(l => l.trim());
      const errorLines = lines.filter(l => /error|warn/i.test(l));

      if (errorLines.length > 0) {
        const limitedErrors = errorLines.slice(-maxLogsPerBatch);

        const logs = limitedErrors.map(line => ({
          source: 'mongodb',
          level: /error/i.test(line) ? 'error' : 'warn',
          message: line,
          timestamp: new Date().toISOString(),
        }));

        try {
          await axios.post(config.receiver_url_logs, { logs });
          console.log(`?? Exported ${logs.length} MongoDB logs`);
        } catch (err) {
          console.error('? Failed to send MongoDB logs:', err.message);
        }
      } else {
        console.log('?? No new MongoDB error logs');
      }
    });
  } catch (err) {
    console.error('? MongoDB log watcher error:', err.message);
  }
}

function startLogWatcher(config) {
  console.log(`? MongoDB log watcher started (interval: ${config.log_check_interval || 300}s)`);

  setInterval(() => {
    checkMongoLogs(config);
  }, (config.log_check_interval || 300) * 1000);
}

module.exports = { startLogWatcher };
