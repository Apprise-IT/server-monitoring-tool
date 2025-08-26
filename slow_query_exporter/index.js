'use strict';

const axios = require('axios');
const mysql = require('mysql2/promise');
const { MongoClient } = require('mongodb');

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
    console.log('? Slow Query Exporter started');

    setInterval(async () => {
      try {
        const [mongoSlow, mysqlSlow] = await Promise.all([
          getMongoSlowQueries(config),
          getMySQLSlowQueries(config),
        ]);

        const payload = {
          source: 'slow_query_exporter',
          timestamp: new Date().toISOString(),
          metrics: {
            mongo_slow_queries: mongoSlow,
            mysql_slow_queries: mysqlSlow,
          }
        };
          
        console.log(JSON.stringify(payload, null, 2));
        await axios.post(config.receiver_url, payload);
        
        console.log(`?? Sent slow query data to ${config.receiver_url}`);
      } catch (err) {
        console.error('? Error exporting slow queries:', err.message);
      }
    }, (config.export_interval || 1800) * 1000);

  } catch (err) {
    console.error('? Slow Query Exporter error:', err.message);
  }
}

module.exports = { start };

