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
      
      const stats = {};
      info.split('\n').forEach((line) => {
        if (line && !line.startsWith('#')) {
          const [key, value] = line.split(':');
          if (key && value) {
            stats[key.trim()] = value.trim();
          }
        }
      });
      resolve(stats);
    });
  });
}

function start(config) {
  client.connect().then(() => {
    console.log('✅ Redis Exporter connected');

    setInterval(async () => {
      try {
        const stats = await getRedisStats();
        await axios.post(config.receiver_url, stats);
        console.log(`✔️ Sent Redis metrics to ${config.receiver_url}`);
      } catch (err) {
        console.error('❌ Error exporting Redis metrics:', err.message);
      }
    }, config.interval);
  }).catch(console.error);
}

module.exports = { start };
