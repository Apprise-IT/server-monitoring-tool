const Redis = require('redis');
const axios = require('axios');
const os = require('os');
const moment = require('moment');
const { startLogWatcher } = require("./log_watcher");

let client;

function getServerIP() {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) return alias.address;
    }
  }
  return 'unknown_ip';
}

async function getRedisStats() {
  try {
    const info = await client.info();
    const metrics = {};
    let totalKeys = 0;

    info.split('\n').forEach((line) => {
      if (!line || line.startsWith('#')) return;

      const [key, value] = line.split(':');
      if (!key || value === undefined) return;

      const numVal = Number(value);
      metrics[key.trim()] = isNaN(numVal) ? value.trim() : numVal;

      // count total keys from keyspace lines, e.g., db0:keys=10,expires=0,avg_ttl=0
      if (key.startsWith('db')) {
        const match = value.match(/keys=(\d+)/);
        if (match) totalKeys += Number(match[1]);
      }
    });

    metrics.total_keys = totalKeys;
    return metrics;
  } catch (err) {
    console.error('❌ Error fetching Redis stats:', err.message);
    return {
      connected_clients: 0,
      used_memory: 0,
      used_memory_rss: 0,
      total_commands_processed: 0,
      total_connections_received: 0,
      expired_keys: 0,
      evicted_keys: 0,
      keyspace_hits: 0,
      keyspace_misses: 0,
      total_keys: 0
    };
  }
}

async function sendMetrics(config, app, ip, purpose) {
  try {
    const metrics = await getRedisStats();
    const timestamp = moment();
    const dateStr = timestamp.format('YYYY-MM-DD');
    const timeStr = timestamp.format('hh:mm:ssA');

    const payload = {
      app,
      ip,
      purpose,
      source: 'redis',
      metrics,
      timestamp: timestamp.toISOString(),
      file_path: `metrics_collector/${app}/${ip}/redis/${dateStr}/${timeStr}.jsonl.gz`,
      log_file_path: `metrics_collector/${app}/${ip}/logs/redis/${dateStr}/${timeStr}.jsonl.gz`
    };

    await axios.post(config.receiver_url, payload);
    console.log(`✅ Sent Redis metrics to ${config.receiver_url}`);
  } catch (err) {
    console.error('❌ Error exporting Redis metrics:', err.message);
  }
}

function scheduleNext(config, app, ip, purpose, intervalMs) {
  const now = Date.now();
  const next = Math.ceil(now / intervalMs) * intervalMs;
  const delay = next - now;

  setTimeout(async () => {
    await sendMetrics(config, app, ip, purpose);
    scheduleNext(config, app, ip, purpose, intervalMs);
  }, delay);
}

function start(config) {
  const app = config.global?.app_name || 'unknown_app';
  const purpose = config.global?.purpose || '';
  const ip = getServerIP();

  client = Redis.createClient({
    socket: {
      host: config.redis_host || '127.0.0.1',
      port: config.redis_port || 6379,
    },
    password: config.redis_password || undefined,
  });

  client.on('error', (err) => console.error('Redis Client Error:', err.message));

  client.connect()
    .then(() => {
      console.log('✅ Redis Exporter connected');

      const intervalMs = (config.export_interval || 30) * 1000;
      scheduleNext(config, app, ip, purpose, intervalMs);

      if (config.redis_log_file && config.receiver_url_logs) {
        startLogWatcher(config);
      } else {
        console.warn('⚠ Redis log watcher not started: check redis_log_file and receiver_url_logs in config');
      }
    })
    .catch((err) => console.error('❌ Redis client connection failed:', err.message));
}

module.exports = { start };
