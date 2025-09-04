const { MongoClient } = require('mongodb');
const axios = require('axios');
const os = require('os');
const moment = require('moment');
const { startLogWatcher } = require('./log_watcher');

let client;
let db;

function getServerIP() {
  const interfaces = os.networkInterfaces();
  for (let iface of Object.values(interfaces)) {
    for (let alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) {
        return alias.address;
      }
    }
  }
  return 'unknown_ip';
}

// Fetch MongoDB server metrics
async function getMongoStats() {
  try {
    if (!db) throw new Error('MongoDB client not connected');
    const serverStatus = await db.command({ serverStatus: 1 });

    return {
      status: 'up',
      uptime_seconds: serverStatus.uptime,
      connections_current: serverStatus.connections.current,
      connections_available: serverStatus.connections.available,
      mem_resident_mb: serverStatus.mem.resident,
      mem_virtual_mb: serverStatus.mem.virtual,
      mem_mapped_mb: serverStatus.mem.mapped,
      opcounters_insert: serverStatus.opcounters.insert,
      opcounters_query: serverStatus.opcounters.query,
      opcounters_update: serverStatus.opcounters.update,
      opcounters_delete: serverStatus.opcounters.delete,
      opcounters_getmore: serverStatus.opcounters.getmore,
      opcounters_command: serverStatus.opcounters.command,
    };
  } catch (err) {
    console.error('❌ getMongoStats failed:', err.message);
    return {
      status: 'down',
      uptime_seconds: 0,
      connections_current: 0,
      connections_available: 0,
      mem_resident_mb: 0,
      mem_virtual_mb: 0,
      mem_mapped_mb: 0,
      opcounters_insert: 0,
      opcounters_query: 0,
      opcounters_update: 0,
      opcounters_delete: 0,
      opcounters_getmore: 0,
      opcounters_command: 0,
    };
  }
}

// Fetch API log stats (current hour)
async function getApiLogStats() {
  const logsCollection = db.collection('logs');

  const now = new Date();
  const startOfCurrentHour = new Date(now);
  startOfCurrentHour.setMinutes(0, 0, 0);

  const totalLogs = await logsCollection.countDocuments();
  const requestsCurrentHour = await logsCollection.countDocuments({
    date: { $gte: startOfCurrentHour },
  });
  const successCountCurrentHour = await logsCollection.countDocuments({
    date: { $gte: startOfCurrentHour },
    status: 200,
  });

  const successRateCurrentHour =
    requestsCurrentHour > 0
      ? ((successCountCurrentHour / requestsCurrentHour) * 100).toFixed(2)
      : '0.00';

  return {
    total_api_logs: totalLogs,
    requests_current_hour: requestsCurrentHour,
    response_success_rate_current_hour: successRateCurrentHour,
  };
}

// Start exporter
async function start(config) {
  const ip = getServerIP();
  const app = config.global?.app_name || 'unknown_app';
  const purpose = config.global?.purpose || '';
  const source = 'mongodb';
  const interval = (config.interval || 30) * 1000; // ms

  try {
    client = new MongoClient(config.mongo_uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    await client.connect();
    db = client.db(config.mongo_db || 'livolive');
    console.log('✅ MongoDB Exporter connected');

    async function sendMetrics() {
      try {
        const metrics = await getMongoStats();
        const api_logs = await getApiLogStats();
        const timestamp = moment();
        const dateStr = timestamp.format('YYYY-MM-DD');
        const timeStr = timestamp.format('hh:mm:ssA');

        const payload = {
          app,
          ip,
          purpose,
          source,
          metrics,
          api_logs,
          timestamp: timestamp.toISOString(),
          file_path: `metrics_collector/${app}/${ip}/${source}/${dateStr}/${timeStr}.jsonl.gz`,
          log_file_path: `metrics_collector/${app}/${ip}/logs/${source}/${dateStr}/${timeStr}.jsonl.gz`,
        };

        await axios.post(config.receiver_url, payload);
        console.log(`✅ Sent ${source} metrics + API logs to ${config.receiver_url}`);
      } catch (err) {
        console.error(`❌ Error exporting ${source} metrics:`, err.message);
      }
    }

    function scheduleNext() {
      const now = Date.now();
      const next = Math.ceil(now / interval) * interval;
      const delay = next - now;

      setTimeout(async () => {
        await sendMetrics();
        scheduleNext();
      }, delay);
    }

    scheduleNext();

    // Logs watcher
    if (config.mongo_log_file && config.receiver_url_logs) {
      startLogWatcher(config);
    } else {
      console.warn('⚠ MongoDB log watcher not started: check mongo_log_file and receiver_url_logs in config');
    }

  } catch (err) {
    console.error('❌ MongoDB connection error:', err.message);
  }
}

module.exports = { start };
