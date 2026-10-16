"use strict";

// No polling or persistent background worker. Timers exist only for queued work.
function included(name, configDir = '.obsidian') {
  if (!name || /[\r\n\0]/.test(name) || name.startsWith('/') || name.includes('\\')) return false;
  const parts = name.split('/');
  if (parts.some(p => !p || p === '..' || p === '.' || p.includes(':'))) return false;
  if (name === configDir || name.startsWith(configDir + '/')) return false;
  return !parts.some(p => ['.git', '.trash'].includes(p.toLowerCase()));
}

function copyArguments({ vault, remote, configFile = '', configDir = '.obsidian', listFile = '' }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(remote)) throw new Error('Remote 名称只能包含字母、数字、下划线和短横线。');
  if (!/^[A-Za-z0-9_.-]+$/.test(configDir)) throw new Error('不支持当前配置目录名称。');
  const args = [
    'copy', vault, `${remote}:Obsidian`, '--checksum',
    '--transfers', '2', '--checkers', '2', '--tpslimit', '4',
    '--retries', '2', '--low-level-retries', '3', '--retries-sleep', '5s',
    '--contimeout', '15s', '--timeout', '60s',
    '--stats', '2s', '--stats-log-level', 'NOTICE', '--stats-one-line',
    '--log-level', 'NOTICE', '--use-json-log',
    '--drive-skip-shortcuts', '--drive-acknowledge-abuse=false'
  ];
  if (configFile) args.push('--config', configFile);
  // rclone rejects --files-from-raw combined with other filters. Incremental
  // paths have already passed included() in upload(); full scans need excludes.
  if (listFile) args.push('--files-from-raw', listFile, '--no-traverse');
  else args.push('--exclude', `/${configDir}/**`, '--exclude', '.git/**', '--exclude', '.trash/**');
  return args;
}

function progressFromStats(stats, totalFiles) {
  if (!stats || !Number.isFinite(totalFiles) || totalFiles < 1) return null;
  const checks = Math.max(0, Number(stats.checks) || 0);
  const transfers = Math.max(0, Number(stats.transfers) || 0);
  const active = Array.isArray(stats.transferring) ? stats.transferring.reduce((sum, file) => {
    const size = Number(file.size), bytes = Number(file.bytes);
    return sum + (size > 0 && Number.isFinite(bytes) ? Math.min(1, Math.max(0, bytes / size)) : 0);
  }, 0) : 0;
  const completed = checks + transfers;
  // A transfer may show 100% before rclone finishes its remote commit/check.
  return { completed: Math.min(totalFiles, completed), total: totalFiles,
    percent: Math.min(99, Math.max(0, Math.floor(100 * (completed + active) / totalFiles))) };
}

class SyncQueue {
  constructor({ upload, report = () => {}, delayMs = 5000, retryMs = 60000, maxRetries = 3,
    // Browser timers require their Window receiver, not this SyncQueue instance.
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id) }) {
    Object.assign(this, { upload, report, delayMs, retryMs, maxRetries, setTimer, clearTimer });
    this.pending = new Set(); this.full = false; this.running = false;
    this.stopped = false; this.timer = null; this.failures = 0; this.aborter = null;
  }
  add(name) {
    if (this.stopped) return;
    this.pending.add(name); this.failures = 0;
    if (!this.running) this.schedule(this.delayMs);
  }
  forget(name) {
    for (const p of this.pending) if (p === name || p.startsWith(name + '/')) this.pending.delete(p);
  }
  requestFull(immediate = false) {
    if (this.stopped) return;
    this.full = true; this.failures = 0;
    if (!this.running) this.schedule(immediate ? 0 : this.delayMs);
  }
  schedule(ms) {
    if (this.stopped) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.report(ms === this.retryMs ? '等待重试' : '等待上传');
    this.timer = this.setTimer(() => { this.timer = null; void this.drain(); }, ms);
  }
  async drain() {
    if (this.stopped || this.running || (!this.full && !this.pending.size)) return;
    const job = { full: this.full, paths: [...this.pending] };
    this.full = false; this.pending.clear(); this.running = true;
    this.aborter = new AbortController(); let failed = false;
    this.report('正在上传');
    try {
      await this.upload(job, this.aborter.signal);
      this.failures = 0;
    } catch (err) {
      failed = true;
      if (!this.stopped) {
        this.full ||= job.full;
        for (const p of job.paths) this.pending.add(p);
        this.failures++;
        this.report('同步失败', err);
      }
    } finally {
      this.running = false; this.aborter = null;
      if (!this.stopped && (this.full || this.pending.size)) {
        if (!failed) this.schedule(this.delayMs);
        else if (this.failures <= this.maxRetries) this.schedule(this.retryMs);
        // After bounded retries, retain work and wait for a new edit/manual sync.
      } else if (!this.stopped && !failed) this.report('已同步');
    }
  }
  stop() {
    this.stopped = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null; this.aborter?.abort();
    this.pending.clear(); this.full = false;
  }
}
module.exports = { included, copyArguments, progressFromStats, SyncQueue };
