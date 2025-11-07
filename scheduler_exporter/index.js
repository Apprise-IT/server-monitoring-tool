'use strict';

const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

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

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function appendDailyLogFile(logDir, filename, data) {
  ensureDir(logDir);
  const filePath = path.join(logDir, filename);
  fs.appendFileSync(filePath, JSON.stringify(data) + '\n');
}

// =======================
// CRON Collector
// =======================
async function getCronLogs(config, lastExportTime) {
  const syslogPath = fs.existsSync('/var/log/syslog')
    ? '/var/log/syslog'
    : '/var/log/cron';
  const maxLogs = config.max_logs || 100;

  try {
    const logData = fs.readFileSync(syslogPath, 'utf8');
    const lines = logData
      .split('\n')
      .filter(line => line.includes('CRON'))
      .slice(-2000); // sample recent entries

    const parsed = lines
      .map(line => {
        const match = line.match(
          /^(\w+\s+\d+\s+\d+:\d+:\d+)\s+[\w-]+\s+CRON\[(\d+)\]:\s+\(([^)]+)\)\s+CMD\s+\((.+)\)$/
        );
        if (!match) return null;
        const [_, dateStr, pid, user, cmd] = match;
        const timestamp = new Date(`${new Date().getFullYear()} ${dateStr}`);
        return {
          source: 'cron',
          job_id: pid,
          user,
          command: cmd,
          status: 'executed',
          timestamp: timestamp.toISOString(),
        };
      })
      .filter(e => e && new Date(e.timestamp) > lastExportTime)
      .slice(-maxLogs);

    return parsed;
  } catch (err) {
    console.error(`‚ùå Error reading cron logs: ${err.message}`);
    return [];
  }
}

// =======================
// Systemd Timer Collector
// =======================
async function getSystemdTimers(config) {
  try {
    const output = execSync(
      'systemctl list-timers --all --no-pager --no-legend',
      { encoding: 'utf8' }
    );

    const lines = output
      .trim()
      .split('\n')
      .filter(line => line.trim() !== '');

    const timers = lines.map(line => {
      const parts = line.trim().split(/\s+/);

      // Extract UNIT and ACTIVATES from the last 2 columns reliably
      const activates = parts.pop();
      const unit = parts.pop();

      // Extract PASSED and LEFT from the end of the remaining columns
      let passed = 'n/a';
      let left = 'n/a';
      let lastRun = 'n/a';
      let nextRun = 'n/a';

      // Remaining columns contain NEXT RUN timestamp, LEFT, LAST RUN timestamp, PASSED
      const remaining = parts.join(' ');

      // Regex to capture NEXT RUN, LEFT, LAST RUN, PASSED
      // Example line:
      // Thu 2025-11-06 10:46:39 UTC 42min left  Wed 2025-11-05 10:46:39 UTC 23h ago
      const regex = /^(.*?)\s+([0-9a-z ]+)\s+left\s+(.*?)\s+([0-9a-z ]+)\s+ago$/i;
      const match = remaining.match(regex);

      if (match) {
        nextRun = match[1].trim();
        left = match[2].trim() + ' left';
        lastRun = match[3].trim();
        passed = match[4].trim() + ' ago';
      } else {
        // Handle lines with n/a
        nextRun = remaining.includes('n/a') ? 'n/a' : remaining;
      }

      return {
        source: 'systemd',
        job_id: unit,
        command: activates,
        status: 'scheduled',
        next_run: nextRun,
        last_run: lastRun,
        left: left,
        passed: passed,
        timestamp: new Date().toISOString(),
      };
    });

    return timers;
  } catch (err) {
    console.error(`‚ùå Error fetching systemd timers: ${err.message}`);
    return [];
  }
}


// =======================
// Main Exporter
// =======================
async function start(config) {
  try {
    console.log('Ì†ΩÌ≥° Scheduler Log Exporter started');
    const app = config.global?.app_name || 'unknown_app';
    const purpose = config.global?.purpose || '';
    const logWindowMinutes = config.export_interval/60 || 10;
    const ip = getServerIP();

    let lastExportTime = new Date(Date.now() - 10 * 60 * 1000); // default 10 min

    setInterval(async () => {
      try {
        const allLogs = [];

        for (const source of config.sources || []) {
          if (!source.enabled) continue;

          let logs = [];
          if (source.type === 'cron') {
            logs = await getCronLogs(source, lastExportTime);
          } else if (source.type === 'systemd') {
            logs = await getSystemdTimers(source);
          }

          allLogs.push(...logs);

          const today = new Date().toISOString().slice(0, 10);
          const logDir = path.join(
            __dirname,
            'metrics_collector',
            app,
            ip,
            'logs',
            source.type
          );
          appendDailyLogFile(logDir, `${today}.jsonl`, logs);
        }

        if (allLogs.length === 0) {
          console.log('‚ÑπÔ∏è No new scheduler logs in this interval.');
          return;
        }

        const payload = {
          app,
          ip,
          purpose,
          timestamp: new Date().toISOString(),
          metrics: { scheduler_logs: allLogs },
        };

        await axios.post(config.receiver_url, payload);
        console.log(`‚úÖ Exported ${allLogs.length} scheduler logs ‚Üí ${config.receiver_url}`);

        lastExportTime = new Date();
      } catch (err) {
        console.error('‚ùå Error exporting scheduler logs:', err.message);
      }
    }, (config.export_interval || 300) * 1000);
  } catch (error) {
    console.error({ error });
  }
}

module.exports = { start };
