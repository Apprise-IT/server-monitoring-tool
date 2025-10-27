// api_log_exporter.js
'use strict';

const axios = require('axios');
const fs = require('fs');
const os = require('os');
const { parse } = require('nginx-log-parser');

// Define Nginx log format based on your example
const NGINX_LOG_FORMAT = '$remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent "$http_referer" "$http_user_agent"';

// Initialize log parser
const parser = parse(NGINX_LOG_FORMAT, {
  remote_addr: String,
  remote_user: String,
  time_local: String,
  request: String,
  status: Number,
  body_bytes_sent: Number,
  http_referer: String,
  http_user_agent: String,
});

function getServerIP() {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) return alias.address;
    }
  }
  return 'unknown_ip';
}

async function getApiLogs(config) {
  const logFilePath = config.access_log_path || '/var/log/nginx/access.log';
  const maxLogs = config.max_logs || 100;
  const logWindowMinutes = config.log_window_minutes || 30;
  const cutoffTime = new Date(Date.now() - logWindowMinutes * 60 * 1000);

  try {
    // Read the log file
    const logData = fs.readFileSync(logFilePath, 'utf8');
    const logLines = logData.split('\n').filter(line => line.trim() !== '');

    // Parse logs and filter by time
    const parsedLogs = logLines
      .map(line => {
        try {
          const parsed = parser(line);
          // Parse Nginx time_local (e.g., "27/Oct/2025:06:59:22 +0000")
          const logTime = new Date(parsed.time_local.replace(/:/, ' '));
          return { ...parsed, timestamp: logTime };
        } catch (err) {
          console.warn(`⚠ Failed to parse log line: ${line}`, err.message);
          return null;
        }
      })
      .filter(log => log && log.timestamp >= cutoffTime)
      .slice(-maxLogs); // Take the most recent logs

    return parsedLogs.map(log => {
      // Split request into method, endpoint, and protocol
      const [method, endpoint, protocol] = log.request.split(' ');
      return {
        remote_addr: log.remote_addr,
        method: method || 'UNKNOWN',
        endpoint: endpoint || 'UNKNOWN',
        status: log.status,
        response_time: null, // Not available in your log format
        timestamp: log.timestamp.toISOString(),
        user_agent: log.http_user_agent,
        bytes_sent: log.body_bytes_sent,
        request_body: null, // Placeholder
        headers: null, // Placeholder
        response: null, // Placeholder
      };
    });
  } catch (err) {
    console.error(`❌ Error reading or parsing Nginx access log: ${err.message}`);
    return [];
  }
}

async function start(config) {
  try {
    console.log('🚀 API Log Exporter started');

    const app = config.global?.app_name || 'unknown_app';
    const purpose = config.global?.purpose || '';
    const ip = getServerIP();

    setInterval(async () => {
      try {
        const apiLogs = await getApiLogs(config);

        const payload = {
          app,
          ip,
          purpose,
          source: 'api_log_exporter',
          timestamp: new Date().toISOString(),
          metrics: {
            api_logs: apiLogs,
          },
          file_path: `metrics_collector/${app}/${ip}/apilogs/${new Date()
            .toISOString()
            .slice(0, 10)}/${Date.now()}.jsonl.gz`,
          log_file_path: `metrics_collector/${app}/${ip}/logs/apilogs/${new Date()
            .toISOString()
            .slice(0, 10)}/${Date.now()}.jsonl.gz`,
        };

        await axios.post(config.receiver_url, payload);
        console.log(`✅ Sent API log data to ${config.receiver_url}`);
      } catch (err) {
        console.error('❌ Error exporting API logs:', err.message);
      }
    }, (config.export_interval || 1800) * 1000);

  } catch (err) {
    console.error('❌ API Log Exporter error:', err.message);
  }
}

module.exports = { start };