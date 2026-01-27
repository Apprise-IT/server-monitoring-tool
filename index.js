const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');
const axios = require('axios');

let anyExporterStarted = false;

const configPath = path.join(__dirname, 'config.yml');
let config;

try {
  config = yaml.load(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error("❌ Failed to load config.yml:", err);
  process.exit(1);
}

async function initExporter(name, folder) {
  const exporterConfig = config[`${name}_exporter`];

  if (!exporterConfig?.enabled) {
    console.log(`⏭ Skipping ${name} exporter (disabled or not configured).`);
    return false;
  }

  console.log(`✅ Starting ${name} exporter... ${Date.now()}`);

  try {
    const exporter = require(`./${folder}`);

    if (typeof exporter.start !== 'function') {
      console.warn(`⚠ ${name} exporter has no start() method, skipping.`);
      return false;
    }

    const started = await exporter.start({
      ...exporterConfig,
      global: config.global,
    });

    return started === true;
  } catch (err) {
    console.error(`❌ Failed to start ${name} exporter:`, err);
    return false;
  }
}

async function getPublicIP() {
  try {
    const res = await axios.get('https://api.ipify.org?format=json');
    return res.data.ip;
  } catch (err) {
    console.error("Failed to get public IP:", err.message);
    return 'unknown_ip';
  }
}

async function notifyServer() {
  try {
    await axios.post(
      'http://server.klapify.com/api/monitoring/server-check',
      {
        ip: await getPublicIP()
      },
      {
        headers: {
          'X-MONITOR-KEY': config.global?.monitor_key,
        },
        timeout: 5000,
      }
    );

    console.log('📡 Server check sent successfully');
  } catch (err) {
    console.error('❌ Failed to send server check:', err.message);
  }
}

// Run all exporters
(async () => {
  const results = await Promise.all([
    initExporter("redis", "redis_exporter"),
    initExporter("mysql", "mysql_exporter"),
    initExporter("mongodb", "mongodb_exporter"),
    initExporter("slow_query", "slow_query_exporter"),
    initExporter("linux", "linux_exporter"),
    initExporter("api_log", "api_log_exporter"),
    initExporter("scheduler", "scheduler_exporter"),
  ]);

  // If any exporter started successfully, notify Laravel
  if (results.some(Boolean)) {
    await notifyServer();
  } else {
    console.warn('⚠ No exporters started, skipping server-check POST');
  }
})();
