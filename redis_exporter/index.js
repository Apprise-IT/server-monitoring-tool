const Redis = require('redis');
const axios = require('axios');

let client; // Declare client here for scope

async function getRedisStats() {
  return new Promise((resolve, reject) => {
    client.info((err, info) => {
      if (err) return reject(err);

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
      resolve(metrics);
    });
  });
}

function start(config) {
  // Use config parameters to create the Redis client
  client = Redis.createClient({
    host: config.redis_host || '127.0.0.1',
    port: config.redis_port || 6379,
    password: config.redis_password || undefined,
  });

  client.on('error', (err) => {
    console.error('Redis Client Error', err);
  });

  client.connect().then(() => {
    console.log('✅ Redis Exporter connected');

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
    }, config.export_interval || 30000); // fallback 30 sec
  }).catch(console.error);
}

module.exports = { start };
