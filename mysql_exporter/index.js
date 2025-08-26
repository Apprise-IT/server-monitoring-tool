const mysql = require('mysql2/promise');
const axios = require('axios');
const { startLogWatcher } = require('./log_watcher');

let connectionConfig;

async function getMySQLStats() {
  let connection;
  try {
    connection = await mysql.createConnection(connectionConfig);

    const [statusRows] = await connection.query('SHOW GLOBAL STATUS');
    const [variableRows] = await connection.query('SHOW GLOBAL VARIABLES');

    const status = Object.fromEntries(statusRows.map(r => [r.Variable_name, r.Value]));
    const variables = Object.fromEntries(variableRows.map(r => [r.Variable_name, r.Value]));

    return {
      status: 'up',
      uptime_seconds: Number(status.Uptime || 0),
      connections: Number(status.Connections || 0),
      threads_connected: Number(status.Threads_connected || 0),
      threads_running: Number(status.Threads_running || 0),
      max_connections: Number(variables.max_connections || 0),
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
    console.error('‚ùå Error fetching MySQL stats:', err.message);

    // Return default data with status=down
    return {
      status: 'down',
      uptime_seconds: 0,
      connections: 0,
      threads_connected: 0,
      threads_running: 0,
      max_connections: 0,
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

function start(config) {
  connectionConfig = {
    host: config.mysql_host || '127.0.0.1',
    port: config.mysql_port || 3306,
    user: config.mysql_user || 'root',
    password: config.mysql_password || '',
  };

  console.log('‚úÖ MySQL Exporter started');

  setInterval(async () => {
    try {
      const metrics = await getMySQLStats();

      const payload = {
        source: 'mysql',
        metrics,
        timestamp: new Date().toISOString(),
      };

      await axios.post(config.receiver_url, payload);
      console.log(`Ì†ΩÌ≥§ Sent MySQL metrics to ${config.receiver_url}`);
    } catch (err) {
      console.error('‚ùå Error exporting MySQL metrics:', err.message);
    }
  }, (config.export_interval || 30) * 1000);

  if (config.mysql_log_file && config.receiver_url_logs) {
    startLogWatcher(config);
  } else {
    console.warn('‚ö† MySQL log watcher not started: check mysql_log_file and receiver_url_logs in config');
  }
}

module.exports = { start };
