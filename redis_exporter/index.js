const Redis = require('redis');
const axios = require('axios');
const { startLogWatcher } = require("./log_watcher"); // new log watcher

let client; // Redis client

async function getRedisStats() {
  try {
    const info = await client.info();
    const metrics = {};
    info.split('\n').forEach((line) => {
      if (line && !line.startsWith('#')) {
        const [key, value] = line.split(':');
        if (key && value) {
          const numVal = Number(value);
          metrics[key.trim()] = isNaN(numVal) ? value.trim() : numVal;
        }
      }
    });
    return metrics;
  } catch (err) {
    console.error('❌ getRedisStats failed:', err.message);
    throw err;
  }
}

function start(config) {
  // --- Redis client setup ---
  client = Redis.createClient({
    socket: {
      host: config.redis_host || '127.0.0.1',
      port: config.redis_port || 6379,
    },
    password: config.redis_password || undefined,
  });

  client.on('error', (err) => {
    console.error('Redis Client Error', err.message);
  });

  client.connect()
    .then(() => {
      console.log('✅ Redis Exporter connected');

      // --- Metrics exporter ---
      setInterval(async () => {
        try {
          const metrics = await getRedisStats();
          const payload = {
            source: 'redis',
            metrics,
            timestamp: new Date().toISOString(),
          };
          await axios.post(config.receiver_url, payload);
          console.log(`✔️ Sent Redis metrics to ${config.receiver_url}`);
        } catch (err) {
          console.error('❌ Error exporting Redis metrics:', err.message);
        }
      }, (config.export_interval || 30) * 1000); // default 30 sec

      // --- Log watcher for production-level errors ---
      if (config.redis_log_file && config.receiver_url_logs) {
        startLogWatcher(config); // automatically polls every 5 min
      } else {
        console.warn('⚠ Redis log watcher not started: check redis_log_file and receiver_url_logs in config');
      }
    })
    .catch((err) => {
      console.error('❌ Redis client connection failed:', err.message);
    });
}

module.exports = { start };
