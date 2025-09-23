'use strict';

const axios = require('axios');
const mysql = require('mysql2/promise');
const { MongoClient } = require('mongodb');
const os = require('os');

function getServerIP() {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) return alias.address;
    }
  }
  return 'unknown_ip';
}

async function getMongoSlowQueries(mongoConfig) {
  const client = new MongoClient(mongoConfig.mongo_uri);

  try {
    await client.connect();
    const db = client.db(mongoConfig.mongo_db);
    const profile = db.collection('system.profile');

    const slowQueries = await profile
      .find({ millis: { $gte: mongoConfig.mongo_slow_threshold_ms || 0 } })
      .sort({ ts: -1 })
      .limit(mongoConfig.max_queries || 50)
      .toArray();

    return slowQueries.map(q => ({
      op: q.op,
      ns: q.ns,
      millis: q.millis,
      query: q.query,
      ts: q.ts,
    }));
  } finally {
    await client.close();
  }
}

async function getMySQLSlowQueries(mysqlConfig) {
  const connection = await mysql.createConnection({
    host: mysqlConfig.mysql_host,
    user: mysqlConfig.mysql_user,
    password: mysqlConfig.mysql_password,
    port: mysqlConfig.mysql_port,
    database: 'mysql',
  });

  try {
    const maxQueries = mysqlConfig.max_queries || 50;
    const [rows] = await connection.execute(`
      SELECT start_time, user_host, query_time, sql_text 
      FROM mysql.slow_log 
      ORDER BY start_time DESC 
      LIMIT ${maxQueries}
    `);

    return rows.map(row => ({
      start_time: row.start_time,
      user_host: row.user_host,
      query_time: row.query_time,
      sql_text: row.sql_text,
    }));
  } finally {
    await connection.end();
  }
}

async function start(config) {
  try {
    console.log('Ì†ΩÌ∫Ä Slow Query Exporter started');

    const app = config.global?.app_name || 'unknown_app';
    const purpose = config.global?.purpose || '';
    const ip = getServerIP();

    setInterval(async () => {
      try {
        const [mongoSlow, mysqlSlow] = await Promise.all([
          getMongoSlowQueries(config),
          getMySQLSlowQueries(config),
        ]);

        const payload = {
          app,
          ip,
          purpose,
          source: 'slow_query_exporter',
          timestamp: new Date().toISOString(),
          metrics: {
            mongo_slow_queries: mongoSlow,
            mysql_slow_queries: mysqlSlow,
          },
          file_path: `metrics_collector/${app}/${ip}/slowquery/${new Date().toISOString().slice(0, 10)}/${Date.now()}.jsonl.gz`,
          log_file_path: `metrics_collector/${app}/${ip}/logs/slowquery/${new Date().toISOString().slice(0, 10)}/${Date.now()}.jsonl.gz`
        };

        //console.log(JSON.stringify(payload, null, 2));
        await axios.post(config.receiver_url, payload);

        console.log(`‚úÖ Sent slow query data to ${config.receiver_url}`);
      } catch (err) {
        console.error('‚ùå Error exporting slow queries:', err.message);
      }
    }, (config.export_interval || 1800) * 1000);

  } catch (err) {
    console.error('‚ùå Slow Query Exporter error:', err.message);
  }
}

module.exports = { start };
