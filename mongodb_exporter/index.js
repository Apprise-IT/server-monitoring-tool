const { MongoClient } = require('mongodb');
const axios = require('axios');
const { startLogWatcher } = require('./log_watcher');

let client;
let db;

// Fetch MongoDB server metrics
async function getMongoStats() {
  if (!db) throw new Error('MongoDB client not connected');
  const serverStatus = await db.command({ serverStatus: 1 });

  return {
    uptime: serverStatus.uptime,
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
}

// Fetch API log stats (current hour)
async function getApiLogStats() {
  const logsCollection = db.collection('logs');

  // Start of current hour
  const now = new Date();
  const startOfCurrentHour = new Date(now);
  startOfCurrentHour.setMinutes(0, 0, 0); // reset minutes, seconds, ms

  // Total API logs count (all time)
  const totalLogs = await logsCollection.countDocuments();

  // Requests in the current hour
  const requestsCurrentHour = await logsCollection.countDocuments({
    date: { $gte: startOfCurrentHour },
  });

  // Successful responses in the current hour
  const successCountCurrentHour = await logsCollection.countDocuments({
    date: { $gte: startOfCurrentHour },
    status: 200,
  });

  // Success rate for current hour
  const successRateCurrentHour =
    requestsCurrentHour > 0
      ? ((successCountCurrentHour / requestsCurrentHour) * 100).toFixed(2)
      : "0.00";

  return {
    total_api_logs: totalLogs,
    requests_current_hour: requestsCurrentHour,
    response_success_rate_current_hour: successRateCurrentHour,
  };
}

// Start the exporter
async function start(config) {
  try {
    client = new MongoClient(config.mongo_uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    await client.connect();
    db = client.db('livolive'); // Connect to default DB
    console.log('‚úÖ MongoDB Exporter connected');

    // Metrics export interval
    setInterval(async () => {
      try {
        const mongoMetrics = await getMongoStats();
        const apiLogStats = await getApiLogStats();

        const payload = {
          source: 'mongodb',
          metrics: mongoMetrics,
          api_logs: apiLogStats,
          timestamp: new Date().toISOString(),
        };

        await axios.post(config.receiver_url, payload);
        console.log(`Ì†ΩÌ≥§ Sent MongoDB metrics + API logs to ${config.receiver_url}`);
      } catch (err) {
        console.error('‚ùå Error exporting MongoDB metrics:', err.message);
      }
    }, (config.export_interval || 30) * 1000);

    // Logs watcher
    if (config.mongo_log_file && config.receiver_url_logs) {
      startLogWatcher(config);
    } else {
      console.warn('‚ö† MongoDB log watcher not started: check mongo_log_file and receiver_url_logs in config');
    }

  } catch (err) {
    console.error('‚ùå MongoDB connection error:', err.message);
  }
}

module.exports = { start };
