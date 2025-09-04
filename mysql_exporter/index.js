const mysql = require('mysql2/promise');
const axios = require('axios');
const os = require('os');
const moment = require('moment');
const { startLogWatcher } = require('./log_watcher');

let connectionConfig;

function getServerIP() {
  const interfaces = os.networkInterfaces();
  for (let iface of Object.values(interfaces)) {
    for (let alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) {
        return alias.address;
      }
    }
  }
  return 'unknown_ip';
}

// Helper: Fetch MySQL stats
async function getMySQLStats() {
  let connection;
  try {
    connection = await mysql.createConnection(connectionConfig);

    const [statusRows] = await connection.query('SHOW GLOBAL STATUS');
    const [variablesRows] = await connection.query('SHOW GLOBAL VARIABLES');

    const status = Object.fromEntries(statusRows.map(r => [r.Variable_name, r.Value]));
    const variables = Object.fromEntries(variablesRows.map(r => [r.Variable_name, r.Value]));

    const max_connections = Number(variables.max_connections || 0);
    const current_connections = Number(status.Threads_connected || 0);

    return {
      status: 'up',
      uptime_seconds: Number(status.Uptime || 0),
      max_connections,
      current_connections,
      threads_running: Number(status.Threads_running || 0),
      queries_per_second: Number(status.Queries || 0) / Math.max(Number(status.Uptime || 1), 1),
      slow_queries: Number(status.Slow_queries || 0),
      open_tables: Number(status.Open_tables || 0),
      table_locks_waited: Number(status.Table_locks_waited || 0),
      table_locks_immediate: Number(status.Table_locks_immediate || 0),
      bytes_received: Number(status.Bytes_received || 0),
      bytes_sent: Number(status.Bytes_sent || 0),
      innodb_buffer_pool_size_bytes: Number(variables.innodb_buffer_pool_size || 0),
      innodb_buffer_pool_reads: Number(status.Innodb_buffer_pool_reads || 0),
      innodb_buffer_pool_read_requests: Number(status.Innodb_buffer_pool_read_requests || 0),
      created_tmp_disk_tables: Number(status.Created_tmp_disk_tables || 0),
      created_tmp_tables: Number(status.Created_tmp_tables || 0),
      created_tmp_files: Number(status.Created_tmp_files || 0),
    };
  } catch (err) {
    console.error('❌ Error fetching MySQL stats:', err.message);

    return {
      status: 'down',
      uptime_seconds: 0,
      max_connections: 0,
      current_connections: 0,
      threads_running: 0,
      queries_per_second: 0,
      slow_queries: 0,
      open_tables: 0,
      table_locks_waited: 0,
      table_locks_immediate: 0,
      bytes_received: 0,
      bytes_sent: 0,
      innodb_buffer_pool_size_bytes: 0,
      innodb_buffer_pool_reads: 0,
      innodb_buffer_pool_read_requests: 0,
      created_tmp_disk_tables: 0,
      created_tmp_tables: 0,
      created_tmp_files: 0,
    };
  } finally {
    if (connection) await connection.end();
  }
}

async function start(config) {
  console.log('✅ MySQL Exporter started');

  connectionConfig = {
    host: config.mysql_host || '127.0.0.1',
    port: config.mysql_port || 3306,
    user: config.mysql_user || 'root',
    password: config.mysql_password || '',
  };

  const ip = getServerIP();
  const app = config.global?.app_name || 'unknown_app';
  const purpose = config.global?.purpose || '';
  const source = 'mysql';
  const interval = (config.interval || 30) * 1000; // ms

  console.log('✅ MySQL Exporter started');

  async function sendMetrics() {
    try {
      const metrics = await getMySQLStats();
      const timestamp = moment();
      const dateStr = timestamp.format('YYYY-MM-DD');
      const timeStr = timestamp.format('hh:mm:ssA');

      const payload = {
        app,
        ip,
        purpose,
        source,
        metrics,
        timestamp: timestamp.toISOString(),
        file_path: `metrics_collector/${app}/${ip}/${source}/${dateStr}/${timeStr}.jsonl.gz`,
        log_file_path: `metrics_collector/${app}/${ip}/logs/${source}/${dateStr}/${timeStr}.jsonl.gz`
      };

      await axios.post(config.receiver_url, payload);
      console.log(`✅ Sent ${source} metrics to ${config.receiver_url}`);
    } catch (err) {
      console.error(`❌ Error exporting ${source} metrics:`, err.message);
    }
  }

  function scheduleNext() {
    const now = Date.now();
    const next = Math.ceil(now / interval) * interval;
    const delay = next - now;

    setTimeout(async () => {
      await sendMetrics();
      scheduleNext();
    }, delay);

    // if (config.mysql_log_file && config.receiver_url_logs) {
    //   startLogWatcher(config);
    // } else {
    //   console.warn('⚠ MySQL log watcher not started: check mysql_log_file and receiver_url_logs in config');
    // }
  }

  scheduleNext();
}

module.exports = { start };
