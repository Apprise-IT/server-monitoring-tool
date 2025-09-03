const osu = require('node-os-utils');
const axios = require('axios');
const os = require('os');

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

async function getLinuxStats() {
  const cpuUsage = await osu.cpu.usage();
  const memInfo = await osu.mem.info();
  const driveInfo = await osu.drive.info();
  const netStats = await osu.netstat.inOut();
  const uptime = osu.os.uptime();
  const loadAvg = os.loadavg();

  return {
    cpu_usage_percent: cpuUsage,
    memory_used_mb: memInfo.usedMemMb,
    memory_free_mb: memInfo.freeMemMb,
    memory_used_percent: memInfo.usedMemPercentage,
    disk_total_gb: driveInfo.totalGb,
    disk_used_gb: driveInfo.usedGb,
    disk_used_percent: driveInfo.usedPercentage,
    net_input_mb: netStats.total.inputMb,
    net_output_mb: netStats.total.outputMb,
    uptime_seconds: uptime,
    load_avg_1: loadAvg[0],
    load_avg_5: loadAvg[1],
    load_avg_15: loadAvg[2]
  };
}

async function start(config) {
  console.log('✅ Linux Exporter started');

  const ip = getServerIP();
  const app = config.global?.app_name || 'unknown_app';
  const source = 'linux';

  const interval = (config.interval || 30) * 1000; // ms

  setInterval(async () => {
    try {
      const metrics = await getLinuxStats();
      const timestamp = new Date().toISOString();
      const dateStr = timestamp.format('YYYY-MM-DD');
      const timeStr = timestamp.format('hh:mm:ssA');

      const payload = {
        app,
        ip,
        source,
        metrics,
        timestamp: timestamp,
        file_path: `metrics_collector/${app}/${ip}/${source}/${dateStr}/${timeStr}.jsonl.gz`,
        log_file_path: `metrics_collector/${app}/${ip}/logs/${source}/${dateStr}/${timeStr}.jsonl.gz`
      };

      await axios.post(config.receiver_url, payload);
      console.log(`📤 Sent Linux metrics to ${config.receiver_url}`);
    } catch (err) {
      console.error('❌ Error exporting Linux metrics:', err.message);
    }
  }, interval);
}

module.exports = { start };
