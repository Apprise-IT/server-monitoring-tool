const fs = require('fs');
const axios = require('axios');
const os = require('os');
const moment = require('moment');

function getServerIP() {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) return alias.address;
    }
  }
  return 'unknown_ip';
}

async function checkMySQLLogs(config, app, ip, purpose) {
  const logFile = config.mysql_log_file || '/var/log/mysql/error.log';
  const maxLogsPerBatch = config.max_logs_per_batch || 100;

  try {
    const data = fs.readFileSync(logFile, 'utf8');
    const lines = data.split('\n').filter(l => l.trim());
    const errorLines = lines.filter(l => /error|warn/i.test(l));

    if (errorLines.length === 0) {
      console.log('â„¹ No MySQL error logs found');
      return;
    }

    // Take only last maxLogsPerBatch
    const limitedErrors = errorLines.slice(-maxLogsPerBatch);

    const logs = limitedErrors.map(line => ({
      source: 'mysql',
      level: /error/i.test(line) ? 'error' : 'warn',
      message: line,
      timestamp: new Date().toISOString(),
    }));

    const timestamp = moment();
    const dateStr = timestamp.format('YYYY-MM-DD');
    const timeStr = timestamp.format('hh:mm:ssA');

    const payload = {
      app,
      ip,
      purpose,
      source: 'mysql_log_watcher',
      logs,
      timestamp: timestamp.toISOString(),
      file_path: `metrics_collector/${app}/${ip}/mysql_logs/${dateStr}/${timeStr}.jsonl.gz`,
      log_file_path: `metrics_collector/${app}/${ip}/logs/mysql/${dateStr}/${timeStr}.jsonl.gz`
    };

    console.log({ payload });

    try {
      await axios.post(config.receiver_url_logs, payload);
      console.log(`âœ… Exported ${logs.length} MySQL logs to ${config.receiver_url_logs}`);
    } catch (err) {
      console.error('âŒ Failed to send MySQL logs:', err.message);
    }

  } catch (err) {
    console.error('âŒ MySQL log watcher error:', err.message);
  }
}

function startLogWatcher(config) {
  console.log(`í ½íº€ MySQL log watcher started (interval: ${config.log_check_interval || 300}s)`);

  const app = config.global?.app_name || 'unknown_app';
  const purpose = config.global?.purpose || '';
  const ip = getServerIP();

  setInterval(() => {
    checkMySQLLogs(config, app, ip, purpose);
  }, (config.log_check_interval || 300) * 1000);
}

module.exports = { startLogWatcher };
