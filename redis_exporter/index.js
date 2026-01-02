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
    // Use 'all' to ensure we get every section, including # Commandstats
    const info = await client.info('all');

    const metrics = {};
    let totalKeys = 0;
    const commandstats = {};

    let currentSection = null;

    const lines = info.split('\n');

    for (let line of lines) {
      line = line.trim();

      // Skip empty lines
      if (!line) continue;

      // Detect section headers like # Memory, # Commandstats, etc.
      if (line.startsWith('#')) {
        currentSection = line.substring(1).trim(); // e.g., "Memory", "Commandstats"
        continue;
      }

      // Split key:value
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;

      const key = line.substring(0, colonIndex).trim();
      const value = line.substring(colonIndex + 1).trim();

      if (currentSection === 'Commandstats' && key.startsWith('cmdstat_')) {
        // Parse cmdstat_get:calls=12345,usec=67890,usec_per_call=5.49,rejected_calls=0,failed_calls=0
        const cmdName = key.substring(8).toLowerCase(); // "get", "set", etc.
        const parts = value.split(',');

        const stats = {};
        parts.forEach(part => {
          const [k, v] = part.split('=');
          if (k && v !== undefined) {
            const num = Number(v);
            stats[k] = isNaN(num) ? v : num;
          }
        });

        commandstats[cmdName] = {
          calls: stats.calls || 0,
          usec: stats.usec || 0,
          usec_per_call: stats.usec_per_call || 0,
          rejected_calls: stats.rejected_calls || 0,
          failed_calls: stats.failed_calls || 0
        };
      } else {
        // Regular key-value metrics
        const numValue = Number(value);
        metrics[key] = isNaN(numValue) ? value : numValue;

        // Accumulate total keys from all databases
        if (key.startsWith('db')) {
          const match = value.match(/keys=(\d+)/);
          if (match) {
            totalKeys += Number(match[1]);
          }
        }
      }
    }

    // Add computed/aggregated fields
    metrics.total_keys = totalKeys;
    metrics.commandstats = commandstats;

    return metrics;

  } catch (err) {
    console.error('❌ Error fetching Redis stats:', err.message);

    // Return safe defaults so dashboard doesn't break
    return {
      connected_clients: 0,
      instantaneous_ops_per_sec: 0,
      used_memory: 0,
      used_memory_human: '0B',
      used_memory_rss: 0,
      total_system_memory: 0,
      total_system_memory_human: '0B',
      total_commands_processed: 0,
      total_connections_received: 0,
      expired_keys: 0,
      evicted_keys: 0,
      keyspace_hits: 0,
      keyspace_misses: 0,
      instantaneous_input_kbps: 0,
      instantaneous_output_kbps: 0,
      connected_slaves: 0,
      blocked_clients: 0,
      total_keys: 0,
      commandstats: {} // Important: always include empty object
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
