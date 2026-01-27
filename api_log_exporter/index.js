'use strict';

const axios = require('axios');
const os = require('os');
const nginxParser = require('nginx-log-parser');
const { MongoClient } = require('mongodb');

// =======================
// NGINX Parser Setup
// =======================
const NGINX_LOG_FORMAT =
  '$remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent "$http_referer" "$http_user_agent"';

const parser = nginxParser(NGINX_LOG_FORMAT);

// =======================
// Helpers
// =======================
function getServerIP() {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) return alias.address;
    }
  }
  return 'unknown_ip';
}

// =======================
// NGINX Log Collector
// =======================
async function getNginxLogs(config, lastExportTime) {
  const fs = require('fs');
  const logFilePath = config.access_log_path || '/var/log/nginx/access.log';
  const logWindowMinutes = config.log_window_minutes || 30;
  const cutoffTime =
    lastExportTime || new Date(Date.now() - logWindowMinutes * 60 * 1000);

  try {
    const logData = fs.readFileSync(logFilePath, 'utf8');
    const logLines = logData.split('\n').filter(line => line.trim() !== '');

    const parsedLogs = logLines
      .map(line => {
        try {
          const parsed = parser(line);
          const logTime = new Date(parsed.time_local.replace(/:/, ' '));
          return { ...parsed, timestamp: logTime };
        } catch {
          return null;
        }
      })
      .filter(log => log && log.timestamp > cutoffTime);

    return parsedLogs.map(log => {
      const [method, endpoint] = log.request.split(' ');
      return {
        remote_addr: log.remote_addr,
        method: method || 'UNKNOWN',
        endpoint: endpoint || 'UNKNOWN',
        status: log.status,
        timestamp: log.timestamp.toISOString(),
        user_agent: log.http_user_agent,
        bytes_sent: log.body_bytes_sent,
        source: 'nginx',
      };
    });
  } catch (err) {
    console.error(`? Error reading Nginx access log: ${err.message}`);
    return [];
  }
}

// =======================
// Mongoose (MongoDB) Log Collector
// =======================
async function getMongooseLogs(config, lastExportTime) {
  const uri = config.mongo_uri;
  const collectionName = config.collection;
  const logWindowMinutes = config.log_window_minutes || 30;

  if (!uri || !collectionName) {
    console.warn(`? Missing MongoDB config for ${config.name}`);
    return [];
  }

  const cutoffTime =
    lastExportTime || new Date(Date.now() - logWindowMinutes * 60 * 1000);

  let client;
  try {
    client = new MongoClient(uri, { connectTimeoutMS: 5000 });
    await client.connect();
    const db = client.db(); // uses DB from URI
    const collection = db.collection(collectionName);

    const logs = await collection
      .find({ date: { $gt: cutoffTime } }) // fetch new logs
      .sort({ date: 1 }) // oldest first
      .toArray();

    return logs.map(log => ({
      ...log,
      timestamp: log.date.toISOString(),
      source: 'mongoose',
    }));
  } catch (err) {
    console.error(`? Error fetching Mongoose logs: ${err.message}`);
    return [];
  } finally {
    if (client) await client.close();
  }
}

// =======================
// Main Exporter
// =======================
async function start(config) {
  console.log('🚀 API Log Exporter started');

  const app = config.global?.app_name || 'unknown_app';
  const purpose = config.global?.purpose || '';
  const ip = getServerIP();

  let lastExportTime = null;

  setInterval(async () => {
    try {
      const allLogs = [];

      for (const source of config.sources || []) {
        if (!source.enabled) continue;

        let logs = [];
        if (source.type === 'nginx') {
          logs = await getNginxLogs(source, lastExportTime);
        } else if (source.type === 'mongoose') {
          logs = await getMongooseLogs(source, lastExportTime);
        }

        if (logs.length === 0) continue;

        allLogs.push(...logs);

        lastExportTime = new Date(
          new Date(logs[logs.length - 1].timestamp).getTime() + 1
        );
      }

      if (allLogs.length === 0) {
        console.log('ℹ️ No new logs found in this interval.');
        return;
      }

      await axios.post(config.receiver_url, {
        app,
        ip,
        purpose,
        timestamp: new Date().toISOString(),
        metrics: { api_logs: allLogs },
      });

      console.log(`✅ Exported ${allLogs.length} logs to ${config.receiver_url}`);
    } catch (err) {
      console.error('❌ Error exporting API logs:', err.message);
    }
  }, (config.export_interval || 300) * 1000);

  return true; // ✅ SIGNAL SUCCESSFUL START
}

module.exports = { start };
