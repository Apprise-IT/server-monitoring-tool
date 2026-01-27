'use strict';

const axios = require('axios');
const os = require('os');
const nginxParser = require('nginx-log-parser');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const url = require('url');
const { spawn } = require('child_process');
const readline = require('readline');

// =======================
// NGINX Parser Setup
// =======================
const NGINX_LOG_FORMAT =
  '$remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent "$http_referer" "$http_user_agent"';
const parser = nginxParser(NGINX_LOG_FORMAT);

// =======================
// Helpers
// =======================
function getServerIP() {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) return alias.address;
    }
  }
  return 'unknown_ip';
}

function parseNginxTime(timeLocal) {
  const match = timeLocal.match(/^(\d+)\/(\w+)\/(\d+):(\d+):(\d+):(\d+) ([+-]\d{4})$/);
  if (!match) return null;

  const [, day, monStr, year, hour, min, sec, tz] = match;
  const months = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
  const month = months[monStr];
  if (month === undefined) return null;

  let date = new Date(Date.UTC(year, month, day, hour, min, sec));
  const tzSign = tz[0] === '+' ? 1 : -1;
  const tzHours = parseInt(tz.slice(1,3),10);
  const tzMins = parseInt(tz.slice(3,5),10);
  date.setUTCMinutes(date.getUTCMinutes() - tzSign * (tzHours*60 + tzMins));

  return date;
}

function parseQuery(qs) {
  if (!qs) return {};
  return Object.fromEntries(new URLSearchParams(qs));
}

// =======================
// NGINX Log Collector
// =======================
async function getNginxLogs(config, lastExportTime) {
  const logFilePath = config.access_log_path || '/var/log/nginx/access.log';
  const logWindowMinutes = config.log_window_minutes || 30;
  const cutoffTime = lastExportTime || new Date(Date.now() - logWindowMinutes * 60 * 1000);

  try {
    const logData = fs.readFileSync(logFilePath, 'utf8');
    const logLines = logData.split('\n').filter(line => line.trim() !== '');

    const formattedLogs = logLines.map(line => {
      const regex = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) ([^"]*?) (\S+)" (\d{3}) (\d+) "(.*?)" "(.*?)"(?: (\d+(?:\.\d+)?))?/;
      const match = line.match(regex);
      if (!match) return null;

      const [_, ip, time_local, method, fullUrl, protocol, status, bytesSent, referer, user_agent, response_time] = match;
      const timestamp = parseNginxTime(time_local);
      if (!timestamp || timestamp < cutoffTime) return null;

      const urlObj = url.parse(fullUrl, true);

      return {
        source: 'nginx',
        method,
        url: fullUrl,
        status: parseInt(status, 10),
        response_time_ms: response_time ? parseFloat(response_time) : 0,
        content_length: parseInt(bytesSent, 10),
        timestamp: timestamp.toISOString(),
        user_agent,
        ip,
        query: urlObj.query || {},
      };
    }).filter(Boolean);

    return formattedLogs;
  } catch (err) {
    console.error(`❌ Error reading Nginx access log: ${err.message}`);
    return [];
  }
}

// =======================
// Mongoose (MongoDB) Log Collector
// =======================
async function getMongooseLogs(config, lastExportTime) {
  const uri = config.mongo_uri;
  const collectionName = config.collection;
  const logWindowMinutes = config.log_window_minutes || 30;

  if (!uri || !collectionName) {
    console.warn(`⚠️ Missing MongoDB config for ${config.name}`);
    return [];
  }

  const cutoffTime =
    lastExportTime || new Date(Date.now() - logWindowMinutes * 60 * 1000);

  let client;
  try {
    client = new MongoClient(uri, { connectTimeoutMS: 5000 });
    await client.connect();
    const db = client.db();
    const collection = db.collection(collectionName);

    const logs = await collection
      .find({ date: { $gt: cutoffTime } })
      .sort({ date: 1 })
      .toArray();

    return logs.map(log => ({
      ...log,
      timestamp: log.date.toISOString(),
      source: 'mongoose',
    }));
  } catch (err) {
    console.error(`❌ Error fetching Mongoose logs: ${err.message}`);
    return [];
  } finally {
    if (client) await client.close();
  }
}

// =======================
// TCPDUMP Live Collector
// =======================
const tcpdumpBuffer = [];
let tcpdumpStarted = false;
let partialHttpBuffer = '';

function startTcpdumpCapture(config) {
  if (tcpdumpStarted) return;
  tcpdumpStarted = true;

  const iface = config.iface || 'eth0';
  const ports = config.ports || [80, 2999, 3000, 4000];
  const portFilter = ports.map(p => `tcp port ${p}`).join(' or ');

  console.log(`📡 Starting tcpdump capture on ${iface}...`);

  const tcpdump = spawn('sudo', [
    'tcpdump',
    '-i', iface,
    '-n',
    '-A',
    `${portFilter} or (tcp port 443 and (tcp[((tcp[12] & 0xf0) >> 2)] = 0x16))`,
  ]);

  const rl = readline.createInterface({ input: tcpdump.stdout });

  rl.on('line', (line) => {
    const now = new Date().toISOString();
    const cleanLine = line.replace(/[^\x20-\x7E]/g, ' ');
    partialHttpBuffer += cleanLine + '\n';

    if (/Host: |GET |POST |PUT |DELETE |PATCH /.test(cleanLine)) {
      const hostMatch = partialHttpBuffer.match(/Host:\s*([^\s]+)/i);
      const reqMatch = partialHttpBuffer.match(/(GET|POST|PUT|DELETE|PATCH)\s+([^\s]+)\s+HTTP\/[0-9.]+/i);

      if (reqMatch && hostMatch) {
        const method = reqMatch[1];
        const endpoint = reqMatch[2];
        const host = hostMatch[1];

        const snippet = partialHttpBuffer
          .split('\n')
          .filter(l => /(Host:|GET|POST|PUT|DELETE|PATCH)/.test(l))
          .join(' | ')
          .slice(0, 500);

        tcpdumpBuffer.push({
          source: 'tcpdump',
          type: 'HTTP',
          host,
          method,
          endpoint,
          requestSnippet: snippet,
          timestamp: now,
        });

        partialHttpBuffer = '';
      }
    }

    if (/443/.test(cleanLine)) {
      const sniMatch = cleanLine.match(/\b([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/);
      if (sniMatch && sniMatch[1] && !sniMatch[1].match(/^\d+\.\d+\.\d+\.\d+$/)) {
        tcpdumpBuffer.push({
          source: 'tcpdump',
          type: 'HTTPS',
          sni: sniMatch[1],
          timestamp: now,
        });
      }
    }

    if (tcpdumpBuffer.length > (config.max_logs || 10000)) {
      tcpdumpBuffer.splice(0, tcpdumpBuffer.length - (config.max_logs || 10000));
    }
  });

  tcpdump.stderr.on('data', (data) => {
    const msg = data.toString();
    if (!msg.includes('listening on')) console.error('⚠️ tcpdump error:', msg.trim());
  });

  process.on('SIGINT', () => {
    tcpdump.kill('SIGTERM');
    rl.close();
    console.log('\n🛑 Stopped tcpdump.');
    process.exit(0);
  });
}

async function getTcpdumpLogs(config) {
  const now = new Date();
  const cutoff = new Date(now - (config.log_window_minutes || 1) * 60 * 1000);
  const recentLogs = tcpdumpBuffer.filter(l => new Date(l.timestamp) > cutoff);
  return recentLogs.splice(0, config.max_logs || 10000);
}

// =======================
// Main Exporter
// =======================
async function start(config) {
  try {
    console.log('🚀 API Log Exporter started');
    const app = config.global?.app_name || 'unknown_app';
    const purpose = config.global?.purpose || '';
    const ip = getServerIP();

    let lastExportTime = null;

    for (const source of config.sources || []) {
      if (source.type === 'tcpdump' && source.enabled) {
        startTcpdumpCapture(source);
      }
    }

    setInterval(async () => {
      try {
        const allLogs = [];

        for (const source of config.sources || []) {
          if (!source.enabled) continue;

          let logs = [];
          if (source.type === 'nginx') {
            logs = await getNginxLogs(source, lastExportTime);
          } else if (source.type === 'mongoose') {
            logs = await getMongooseLogs(source, lastExportTime);
          } else if (source.type === 'tcpdump') {
            logs = await getTcpdumpLogs(source);
          }

          if (logs.length === 0) continue;

          allLogs.push(...logs);
          if (logs[logs.length - 1]?.timestamp)
            lastExportTime = new Date(new Date(logs[logs.length - 1].timestamp).getTime() + 1);
        }

        if (allLogs.length === 0) {
          console.log('⏳ No new logs found in this interval.');
          return;
        }

        await axios.post(config.receiver_url, {
          app,
          ip,
          purpose,
          timestamp: new Date().toISOString(),
          metrics: { api_logs: allLogs },
        });

        console.log(`✅ Exported ${allLogs.length} logs to ${config.receiver_url}`);
      } catch (err) {
        console.error('❌ Error exporting API logs:', err.message);
      }
    }, (config.export_interval || 300) * 1000);

    return true; // ✅ START SUCCESS
  } catch (err) {
    console.error('❌ Failed to start API Log Exporter:', err.message);
    return false; // ❌ START FAILED
  }
}

module.exports = { start };