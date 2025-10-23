const mysql = require('mysql2/promise');
const axios = require('axios');
const os = require('os');
const moment = require('moment');
const fs = require('fs');
const path = require('path');
const { startLogWatcher } = require('./log_watcher');

let connectionConfig;
const DIGEST_SNAPSHOT_DIR = path.join(__dirname, 'query_digest_snapshots');
if (!fs.existsSync(DIGEST_SNAPSHOT_DIR)) fs.mkdirSync(DIGEST_SNAPSHOT_DIR, { recursive: true });

function getServerIP() {
  const interfaces = os.networkInterfaces();
  for (let iface of Object.values(interfaces)) {
    for (let alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) return alias.address;
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
    // New metric: table_open_cache
    const table_open_cache = Number(variables.table_open_cache || 0);
    const open_tables = Number(status.Open_tables || 0);
    const open_tables_ratio = table_open_cache ? open_tables / table_open_cache : 0;

    return {
      status: 'up',
      uptime_seconds: Number(status.Uptime || 0),
      max_connections,
      current_connections,
      threads_running: Number(status.Threads_running || 0),
      queries_per_second: Number(status.Queries || 0) / Math.max(Number(status.Uptime || 1), 1),
      slow_queries: Number(status.Slow_queries || 0),
      table_open_cache,
      open_tables_ratio,
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
      table_open_cache: 0,
      open_tables_ratio: 0,
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

// Fetch query digest metrics (avg query times)
async function getQueryDigestMetrics() {
  let connection;
  try {
    connection = await mysql.createConnection(connectionConfig);

    const [rows] = await connection.query(`
      SELECT 
        SUM(SUM_TIMER_WAIT)/SUM(COUNT_STAR)/1000000000 AS raw_avg_query_time,
        SUM(CASE WHEN DIGEST_TEXT LIKE 'SELECT%' THEN SUM_TIMER_WAIT END) AS select_time,
        SUM(CASE WHEN DIGEST_TEXT LIKE 'SELECT%' THEN COUNT_STAR END) AS select_count,
        SUM(CASE WHEN DIGEST_TEXT LIKE 'INSERT%' THEN SUM_TIMER_WAIT END) AS create_time,
        SUM(CASE WHEN DIGEST_TEXT LIKE 'INSERT%' THEN COUNT_STAR END) AS create_count,
        SUM(CASE WHEN DIGEST_TEXT LIKE 'UPDATE%' THEN SUM_TIMER_WAIT END) AS update_time,
        SUM(CASE WHEN DIGEST_TEXT LIKE 'UPDATE%' THEN COUNT_STAR END) AS update_count,
        SUM(CASE WHEN DIGEST_TEXT LIKE 'DELETE%' THEN SUM_TIMER_WAIT END) AS delete_time,
        SUM(CASE WHEN DIGEST_TEXT LIKE 'DELETE%' THEN COUNT_STAR END) AS delete_count
      FROM performance_schema.events_statements_summary_by_digest;
    `);

    const r = rows[0] || {};

    // Force nulls to 0
    const select_time = r.select_time || 0;
    const select_count = r.select_count || 0;
    const create_time = r.create_time || 0;
    const create_count = r.create_count || 0;
    const update_time = r.update_time || 0;
    const update_count = r.update_count || 0;
    const delete_time = r.delete_time || 0;
    const delete_count = r.delete_count || 0;

    // Compute per-operation averages safely
    const select_avg_query_time_ms = select_count ? select_time / select_count / 1000000000 : 0;
    const create_avg_query_time_ms = create_count ? create_time / create_count / 1000000000 : 0;
    const update_avg_query_time_ms = update_count ? update_time / update_count / 1000000000 : 0;
    const delete_avg_query_time_ms = delete_count ? delete_time / delete_count / 1000000000 : 0;

    // Overall weighted average
    const totalTime = (select_avg_query_time_ms * select_count) +
                      (create_avg_query_time_ms * create_count) +
                      (update_avg_query_time_ms * update_count) +
                      (delete_avg_query_time_ms * delete_count);

    const totalCount = select_count + create_count + update_count + delete_count;

    const avg_query_time_ms = totalCount ? totalTime / totalCount : 0;

    return {
      avg_query_time_ms,
      select_avg_query_time_ms,
      create_avg_query_time_ms,
      update_avg_query_time_ms,
      delete_avg_query_time_ms
    };
  } catch (err) {
    console.error('❌ Error fetching query digest:', err.message);
    return {
      avg_query_time_ms: 0,
      select_avg_query_time_ms: 0,
      create_avg_query_time_ms: 0,
      update_avg_query_time_ms: 0,
      delete_avg_query_time_ms: 0
    };
  } finally {
    if (connection) await connection.end();
  }
}
// Save snapshot and clean old
function saveDigestSnapshot(digestData) {
  const timestamp = Date.now();
  const filePath = path.join(DIGEST_SNAPSHOT_DIR, `${timestamp}.json`);
  fs.writeFileSync(filePath, JSON.stringify(digestData));

  // Cleanup snapshots older than 1 hour
  const cutoff = timestamp - 60 * 60 * 1000;
  fs.readdirSync(DIGEST_SNAPSHOT_DIR).forEach(file => {
    const fileTs = parseInt(path.basename(file, '.json'));
    if (fileTs < cutoff) fs.unlinkSync(path.join(DIGEST_SNAPSHOT_DIR, file));
  });
}

// Compute average over last 1 hour
function computeAvgQueryTimes() {
  const files = fs.readdirSync(DIGEST_SNAPSHOT_DIR);
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;

  let sum = { avg_query_time_ms: 0, select_avg_query_time_ms: 0, create_avg_query_time_ms: 0, update_avg_query_time_ms: 0, delete_avg_query_time_ms: 0 };
  let count = { avg_query_time_ms: 0, select_avg_query_time_ms: 0, create_avg_query_time_ms: 0, update_avg_query_time_ms: 0, delete_avg_query_time_ms: 0 };

  files.forEach(file => {
    const ts = parseInt(path.basename(file, '.json'));
    if (ts < oneHourAgo) return;
    const data = JSON.parse(fs.readFileSync(path.join(DIGEST_SNAPSHOT_DIR, file)));
    for (const key of Object.keys(sum)) {
      if (data[key] !== null && data[key] !== undefined) {
        sum[key] += data[key];
        count[key]++;
      }
    }
  });

  const avg = {};
  for (const key of Object.keys(sum)) avg[key] = count[key] ? sum[key] / count[key] : 0;
  return avg;
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

  async function sendMetrics() {
    try {
      const metrics = await getMySQLStats();
      const digestMetrics = computeAvgQueryTimes(); // last 1 hour averages

      const payload = {
        app,
        ip,
        purpose,
        source,
        metrics: { ...metrics, ...digestMetrics },
        timestamp: moment().toISOString(),
        file_path: `metrics_collector/${app}/${ip}/${source}/${moment().format('YYYY-MM-DD')}/${moment().format('hh:mm:ssA')}.jsonl.gz`,
        log_file_path: `metrics_collector/${app}/${ip}/logs/${source}/${moment().format('YYYY-MM-DD')}/${moment().format('hh:mm:ssA')}.jsonl.gz`
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
  }

  // Start query digest snapshot every 5 minutes
  setInterval(async () => {
    const digest = await getQueryDigestMetrics();
    if (digest) saveDigestSnapshot(digest);
  }, 5 * 60 * 1000);

  scheduleNext();
}

module.exports = { start };
