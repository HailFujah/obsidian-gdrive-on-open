"use strict";
const { Plugin, PluginSettingTab, Setting, Notice, TFile } = require('obsidian');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
// Absolute path: Obsidian's plugin loader is not a normal Node module loader.
// Load sync-core.js after the vault path and manifest directory are available.
const DEFAULTS = {
  enabled: false,
  vaultPath: '',
  rclonePath: '',
  remote: 'gdrive', configFile: '', delaySeconds: 5
};

module.exports = class DriveOnOpen extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.closed = false; this.ready = false; this.activeChild = null; this.queue = null;
    this.lastError = ''; this.status = this.addStatusBarItem();
    this.statusLabel = this.status.createEl('span');
    this.progressBar = this.status.createEl('progress');
    this.progressBar.max = 100;
    Object.assign(this.progressBar.style, { width: '84px', height: '9px', marginLeft: '6px', verticalAlign: 'middle' });
    this.progressBar.hidden = true;
    this.progressPercent = 0;
    const adapter = this.app.vault.adapter;
    if (typeof adapter?.getBasePath !== 'function') {
      this.setStatus('仅支持桌面本地仓库'); return;
    }
    this.vaultPath = adapter.getBasePath();
    if (typeof this.vaultPath !== 'string' || !path.isAbsolute(this.vaultPath)) {
      this.setStatus('无法读取本地仓库路径');
      new Notice('无法读取本地仓库的绝对路径，未启动同步。');
      return;
    }
    if (!this.settings.vaultPath) this.settings.vaultPath = this.vaultPath;
    const pluginDir = path.resolve(this.vaultPath, this.manifest.dir || `${this.app.vault.configDir}/plugins/${this.manifest.id}`);
    this.core = require(path.join(pluginDir, 'sync-core.js'));
    this.addSettingTab(new DriveSettings(this.app, this));
    this.addCommand({ id: 'upload-now', name: '立即检查并上传整个仓库', callback: () => {
      if (!this.queue) new Notice('请先在插件设置中配置并启用同步。');
      else this.queue.requestFull(true);
    }});
    this.addCommand({ id: 'show-error', name: '查看最近同步错误', callback: () => new Notice(this.lastError || '暂无同步错误。', 12000) });
    this.addCommand({ id: 'pause-upload', name: '暂停自动上传', callback: async () => {
      this.settings.enabled = false; await this.saveData(this.settings); this.restart();
    }});
    this.registerEvent(this.app.workspace.on('quit', () => this.shutdown()));
    this.registerDomEvent(window, 'beforeunload', () => this.shutdown());
    this.setStatus('等待仓库加载');
    this.app.workspace.onLayoutReady(() => {
      if (this.closed) return;
      this.ready = true;
      const changed = file => {
        if (file instanceof TFile && this.core.included(file.path, this.app.vault.configDir)) this.queue?.add(file.path);
      };
      this.registerEvent(this.app.vault.on('create', changed));
      this.registerEvent(this.app.vault.on('modify', changed));
      this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
        this.queue?.forget(oldPath);
        if (file instanceof TFile) changed(file);
        else for (const f of this.app.vault.getFiles()) if (f.path.startsWith(file.path + '/')) changed(f);
      }));
      this.registerEvent(this.app.vault.on('delete', file => this.queue?.forget(file.path)));
      this.restart();
    });
  }
  setStatus(text, error) {
    const labels = {
      '正在上传': '扫描中，请勿关闭',
      '等待上传': '即将上传，请勿关闭',
      '等待重试': '等待重试，请勿关闭',
      '已同步': '已完成，可以关闭',
      '同步失败': '上传失败，请检查'
    };
    this.statusLabel?.setText('Drive：' + (labels[text] || text));
    if (this.progressBar) {
      this.progressBar.hidden = ['已暂停', '等待仓库加载', '仅支持桌面本地仓库', '仓库路径不匹配'].includes(text);
      if (text === '正在上传') { this.progressPercent = 0; this.progressBar.removeAttribute('value'); }
      else if (text === '等待上传') this.progressBar.value = 0;
      else if (text === '已同步') this.progressBar.value = 100;
    }
    if (error) {
      this.lastError = String(error.message || error).slice(-2000);
      this.status?.setAttribute('title', this.lastError);
      new Notice('Google Drive 上传失败，可用命令“查看最近同步错误”检查原因。', 6000);
    }
    if (text === '已同步') {
      this.lastError = '';
      this.status?.setAttribute('title', '最后成功检查：' + new Date().toLocaleString());
    }
  }
  showProgress(stats, totalFiles) {
    const progress = this.core.progressFromStats(stats, totalFiles);
    if (!progress || this.closed) return;
    this.progressPercent = Math.max(this.progressPercent, progress.percent);
    this.progressBar.value = this.progressPercent;
    this.statusLabel.setText(`Drive：${this.progressPercent}% · ${progress.completed}/${progress.total} 文件，请勿关闭`);
    this.status.setAttribute('title', `正在检查和上传文件；只有显示“已完成，可以关闭”才表示本轮结束。`);
  }
  restart() {
    this.queue?.stop(); this.queue = null;
    if (this.closed || !this.ready) return;
    if (!this.settings.enabled) { this.setStatus('已暂停'); return; }
    if (path.resolve(this.settings.vaultPath).toLowerCase() !== path.resolve(this.vaultPath).toLowerCase()) {
      this.setStatus('仓库路径不匹配'); new Notice('当前仓库与设置中的仓库路径不一致，未开始上传。'); return;
    }
    const delayMs = Math.max(2, Number(this.settings.delaySeconds) || 5) * 1000;
    this.queue = new this.core.SyncQueue({
      delayMs, upload: (job, signal) => this.upload(job, signal),
      report: (status, error) => this.setStatus(status, error)
    });
    this.queue.requestFull(); // Catch edits made while Obsidian was closed.
  }
  async upload(job, signal) {
    const settings = { ...this.settings }; let temporaryDir = null;
    let totalFiles = job.full
      ? this.app.vault.getFiles().filter(file => this.core.included(file.path, this.app.vault.configDir)).length
      : 0;
    if (signal.aborted) return;
    try {
      if (!path.isAbsolute(settings.rclonePath) || !/\.exe$/i.test(settings.rclonePath)) throw new Error('请在设置中填写 rclone.exe 的绝对路径。');
      await fs.access(settings.rclonePath);
      let listFile = '';
      if (!job.full) {
        const existing = [];
        for (const name of job.paths) {
          if (!this.core.included(name, this.app.vault.configDir)) continue;
          try { if ((await fs.lstat(path.join(this.vaultPath, name))).isFile()) existing.push(name); }
          catch (e) { if (e.code !== 'ENOENT') throw e; }
        }
        if (!existing.length) return;
        totalFiles = existing.length;
        temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-drive-'));
        listFile = path.join(temporaryDir, 'files.txt');
        await fs.writeFile(listFile, existing.join('\n') + '\n', 'utf8');
      }
      const args = this.core.copyArguments({ vault: this.vaultPath, remote: settings.remote,
        configFile: settings.configFile, configDir: this.app.vault.configDir, listFile });
      if (signal.aborted) return;
      await new Promise((resolve, reject) => {
        const child = spawn(settings.rclonePath, args, { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        this.activeChild = child; let tail = ''; let logBuffer = '';
        const cancel = () => child.kill();
        signal.addEventListener('abort', cancel, { once: true });
        const cleanup = () => {
          signal.removeEventListener('abort', cancel);
          if (this.activeChild === child) this.activeChild = null;
        };
        child.stderr.on('data', bytes => {
          logBuffer += bytes.toString('utf8');
          let newline;
          while ((newline = logBuffer.indexOf('\n')) !== -1) {
            const line = logBuffer.slice(0, newline); logBuffer = logBuffer.slice(newline + 1);
            try {
              const entry = JSON.parse(line);
              if (entry.stats && this.activeChild === child && !signal.aborted) this.showProgress(entry.stats, totalFiles);
              else if (entry.level === 'error' || entry.level === 'critical') tail = (tail + '\n' + entry.msg).slice(-2000);
            } catch { tail = (tail + '\n' + line).slice(-2000); }
          }
          if (logBuffer.length > 65536) logBuffer = logBuffer.slice(-65536);
        });
        child.once('error', err => { cleanup(); reject(err); });
        child.once('close', code => {
          cleanup();
          if (signal.aborted) reject(new Error('上传已停止；下次打开仓库会重新检查。'));
          else if (code === 0) resolve();
          else reject(new Error(`rclone 退出码 ${code}。\n${tail || '请检查 rclone 路径、网络和 Google Drive 授权。'}`));
        });
        if (signal.aborted) cancel();
      });
    } finally {
      if (temporaryDir) await fs.rm(temporaryDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  shutdown() {
    this.closed = true; this.queue?.stop(); this.queue = null;
    this.activeChild?.kill(); this.activeChild = null;
  }
  onunload() { this.shutdown(); }
};

class DriveSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this; const plugin = this.plugin; containerEl.empty();
    containerEl.createEl('h2', { text: 'Google Drive 单向上传' });
    containerEl.createEl('p', { text: '打开本仓库时启用；空闲时不扫描。文件保存后合并上传，关闭仓库时停止。首次启用会检查整个仓库。' });
    containerEl.createEl('p', { text: '目标：MyDrive/Obsidian。云端同路径文件以本地版本为准；本地删除或改名不会删除云端旧文件。' });
    const field = (name, desc, key) => new Setting(containerEl).setName(name).setDesc(desc).addText(text => text.setValue(String(plugin.settings[key])).onChange(async value => {
      plugin.settings[key] = value.trim(); await plugin.saveData(plugin.settings);
    }));
    field('本地仓库', '默认使用当前仓库路径；只允许此仓库上传。', 'vaultPath');
    field('rclone.exe 路径', '先安装 rclone，再填写实际的绝对路径。', 'rclonePath');
    field('Remote 名称', '在 rclone config 中配置 Google Drive，建议命名 gdrive，并将根目录保持为 MyDrive。', 'remote');
    field('rclone 配置文件（可选）', '留空使用 rclone 默认配置。无需填写密码或令牌。', 'configFile');
    new Setting(containerEl).setName('合并等待时间（秒）').setDesc('连续保存时等修改停下来再上传，最少 2 秒。').addText(text => text.setValue(String(plugin.settings.delaySeconds)).onChange(async value => {
      if (/^\d+$/.test(value) && Number(value) >= 2 && Number(value) <= 300) {
        plugin.settings.delaySeconds = Number(value); await plugin.saveData(plugin.settings);
      }
    }));
    new Setting(containerEl).setName('启用自动上传').setDesc('完成 rclone 授权后再打开此开关。').addToggle(toggle => toggle.setValue(plugin.settings.enabled).onChange(async enabled => {
      plugin.settings.enabled = enabled; await plugin.saveData(plugin.settings); plugin.restart();
    }));
    new Setting(containerEl).setName('应用设置 / 立即检查').setDesc('修改上方设置后点击此按钮。').addButton(button => button.setButtonText('应用并检查').onClick(() => {
      plugin.restart(); if (!plugin.settings.enabled) new Notice('请先启用自动上传。');
    }));
    containerEl.createEl('p', { text: '上传 Markdown 和附件，默认排除 .obsidian、.git 和 .trash。失败后每 60 秒重试，最多 3 次；之后等待下一次修改或手动检查。' });
  }
}
