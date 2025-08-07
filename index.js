const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');

// Load YAML config
const configPath = path.join(__dirname, 'config.yml');
const config = yaml.load(fs.readFileSync(configPath, 'utf8'));

// Start Redis Exporter if enabled
if (config.redis_exporter?.enabled) {
  const redisExporter = require('./redis-exporter');
  redisExporter.start(config.redis_exporter);
}

// Future: similar blocks for MySQL, MongoDB, Server exporter
