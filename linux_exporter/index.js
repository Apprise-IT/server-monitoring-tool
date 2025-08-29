// linux_exporter.js
const osu = require('node-os-utils');
const axios = require('axios');
const os = require('os');

async function getLinuxStats() {
  try {
    const cpuUsage = await osu.cpu.usage();
    const memInfo = await osu.mem.info();
    const driveInfo = await osu.drive.info();
    const netStats = await osu.netstat.inOut();
    const uptime = osu.os.uptime();
    const loadAvg = os.loadavg(); // <-- Node built-in

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
  } catch (err) {
    throw err;
  }
}

async function start(config) {
  console.log('? Linux Exporter started');

  setInterval(async () => {
    try {
      const metrics = await getLinuxStats();
      const payload = {
        source: 'linux',
        metrics,
        timestamp: new Date().toISOString(),
      };

      await axios.post(config.receiver_url, payload);
      console.log(`?? Sent Linux metrics to ${config.receiver_url}`);
    } catch (err) {
      console.error('? Error exporting Linux metrics:', err.message);
    }
  }, (config.export_interval || 30) * 1000); // default 30 sec
}

module.exports = { start };
