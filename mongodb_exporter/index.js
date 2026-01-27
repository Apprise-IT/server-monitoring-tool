const { MongoClient } = require('mongodb');
const axios = require('axios');
const os = require('os');
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
      network_bytes_in: serverStatus.network?.bytesIn || 0,
      network_bytes_out: serverStatus.network?.bytesOut || 0,
      network_num_requests: serverStatus.network?.numRequests || 0,
      globalLock_active_clients_readers: serverStatus.globalLock?.activeClients?.readers || 0,
      globalLock_active_clients_writers: serverStatus.globalLock?.activeClients?.writers || 0,
      globalLock_current_queue_readers: serverStatus.globalLock?.currentQueue?.readers || 0,
      globalLock_current_queue_writers: serverStatus.globalLock?.currentQueue?.writers || 0,
    };
  } catch (err) {
    console.error('❌ getMongoStats failed:', err.message);
    return { status: 'down' };
  }
}

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

async function start(config) {
  const ip = getServerIP();
  const app = config.global?.app_name || 'unknown_app';
  const purpose = config.global?.purpose || '';
  const source = 'mongodb';
  const interval = (config.interval || 30) * 1000;

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
        const timestamp = new Date();
        const dateStr = timestamp.toISOString().split('T')[0];
        const timeStr = timestamp.toISOString().split('T')[1].replace('Z', '');

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

        await axios.post(config.receiver_url, payload, { timeout: 5000 });
        console.log(`✅ Sent ${source} metrics + API logs to ${config.receiver_url}`);
        return true;
      } catch (err) {
        console.error(`❌ Error exporting ${source} metrics:`, err.message);
        return false;
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

    try {
      if (config.mongo_log_file && config.receiver_url_logs) {
        startLogWatcher(config);
      } else {
        console.warn('⚠ MongoDB log watcher not started: check mongo_log_file and receiver_url_logs in config');
      }
    } catch (err) {
      console.error('❌ Log watcher failed:', err.message);
    }

    return true; // IMPORTANT
  } catch (err) {
    console.error('❌ MongoDB connection error:', err.message);
    return false;
  }
}

module.exports = { start };
