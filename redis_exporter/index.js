const Redis = require('redis');
const axios = require('axios');

const client = Redis.createClient();

client.on('error', (err) => {
  console.error('Redis Client Error', err);
});

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
  client.connect().then(() => {
    console.log('✅ Redis Exporter connected');

    setInterval(async () => {
      try {
        const metrics = await getRedisStats();
        const payload = {
          source: 'redis',
          metrics,
          timestamp: new Date().toISOString()
        };

        await axios.post(config.receiver_url, payload);
        console.log(`✔️ Sent Redis metrics to ${config.receiver_url}`);
      } catch (err) {
        console.error('❌ Error exporting Redis metrics:', err.message);
      }
    }, config.interval);
  }).catch(console.error);
}

module.exports = { start };
