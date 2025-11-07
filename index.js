// main.js
const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');

// Load YAML config
const configPath = path.join(__dirname, 'config.yml');
let config;
try {
  config = yaml.load(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error("❌ Failed to load config.yml:", err);
  process.exit(1);
}

// Helper to start an exporter if config is present
function initExporter(name, folder) {
  const exporterConfig = config[`${name}_exporter`];

  if (exporterConfig?.enabled) {
    console.log(`✅ Starting ${name} exporter... ${Date.now()}`);
    try {
      const exporter = require(`./${folder}`);
      console.log({exporter});
      if (typeof exporter.start === 'function') {
        // ✅ Merge global config into exporterConfig
        exporter.start({
          ...exporterConfig,
          global: config.global, 
        });
      } else {
        console.warn(`⚠ ${name} exporter has no start() method, skipping.`);
      }
    } catch (err) {
      console.error(`❌ Failed to start ${name} exporter:`, err);
    }
  } else {
    console.log(`⏭ Skipping ${name} exporter (disabled or not configured).`);
  }
}

// Initialize all exporters
initExporter("redis", "redis_exporter");
initExporter("mysql", "mysql_exporter");
initExporter("mongodb", "mongodb_exporter");
initExporter("slow_query", "slow_query_exporter");
initExporter("linux", "linux_exporter");
initExporter("api_log", "api_log_exporter");
initExporter("scheduler", "scheduler_exporter");