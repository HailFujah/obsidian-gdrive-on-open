const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { included, copyArguments, progressFromStats, SyncQueue } = require('../sync-core.js');
const flush = () => new Promise(resolve => setImmediate(resolve));

test('default timers never receive the queue as their browser receiver', () => {
  const vm = require('node:vm'); const fs = require('node:fs');
  let scheduled = false; let cleared = false;
  const sandbox = { module: { exports: {} },
    setTimeout: function () { 'use strict'; assert.equal(this, undefined); scheduled = true; return 7; },
    clearTimeout: function (id) { 'use strict'; assert.equal(this, undefined); assert.equal(id, 7); cleared = true; }
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../sync-core.js'), 'utf8'), sandbox);
  const queue = new sandbox.module.exports.SyncQueue({ upload: async () => {} });
  queue.requestFull(); queue.stop();
  assert.ok(scheduled); assert.ok(cleared);
});
function harness(upload, options = {}) {
  const timers = new Map(); let serial = 0; const reports = [];
  const queue = new SyncQueue({ upload, report: (...x) => reports.push(x),
    setTimer: (fn, ms) => { const id = ++serial; timers.set(id, { fn, ms }); return id; },
    clearTimer: id => timers.delete(id), ...options });
  return { queue, timers, reports, async fire() {
    assert.equal(timers.size, 1); const [id, item] = [...timers][0];
    timers.delete(id); item.fn(); await flush();
  }};
}
test('normal note/attachment paths included; config, trash and traversal excluded', () => {
  for (const name of ['Notes/a.md', '中文笔记/图.png', '#开始.md', '笔记 with spaces.md']) assert.ok(included(name));
  for (const name of ['../secret', '/secret', 'C:/secret', '.obsidian/data.json', 'x/.git/config', '.trash/a.md', 'a\nb.md', 'a/./b']) assert.equal(included(name), false);
  assert.equal(included('.custom/data.json', '.custom'), false);
});
test('rclone only copies outward, checks content, and uses literal argument array', () => {
  const vault = String.raw`D:\Vault with spaces\中文 $name`;
  const args = copyArguments({ vault, remote: 'gdrive', listFile: 'C:\\temp\\files.txt' });
  assert.deepEqual(args.slice(0, 3), ['copy', vault, 'gdrive:Obsidian']);
  assert.ok(args.includes('--checksum')); assert.ok(args.includes('--files-from-raw'));
  assert.ok(args.includes('--no-traverse'));
  assert.ok(!args.includes('--exclude'), 'raw file lists must not be combined with exclusion filters');
  const fullArgs = copyArguments({ vault, remote: 'gdrive' });
  assert.ok(fullArgs.includes('/.obsidian/**'));
  assert.ok(fullArgs.includes('.git/**'));
  assert.ok(fullArgs.includes('.trash/**'));
  assert.ok(!fullArgs.includes('--files-from-raw'));
  assert.ok(args.includes('--use-json-log'));
  assert.deepEqual(args.slice(args.indexOf('--stats'), args.indexOf('--stats') + 2), ['--stats', '2s']);
  assert.ok(!args.some(x => ['sync', 'bisync', 'delete', '--delete-excluded', '--update'].includes(x)));
  assert.throws(() => copyArguments({ vault, remote: ':local:/tmp' }));
});
test('progress tracks checked and transferred files without claiming completion early', () => {
  assert.deepEqual(progressFromStats({ checks: 3, transfers: 1, transferring: [{ bytes: 50, size: 100 }] }, 10),
    { completed: 4, total: 10, percent: 45 });
  assert.deepEqual(progressFromStats({ checks: 9, transfers: 1 }, 10),
    { completed: 10, total: 10, percent: 99 });
  assert.equal(progressFromStats({ checks: 0 }, 0), null);
});
test('idle has no timers; repeated saves coalesce and no recurring work remains', async () => {
  const jobs = []; const h = harness(async job => jobs.push(job));
  assert.equal(h.timers.size, 0);
  h.queue.add('a.md'); h.queue.add('a.md'); h.queue.add('附件.png');
  assert.equal(h.timers.size, 1); await h.fire();
  assert.deepEqual(jobs, [{ full: false, paths: ['a.md', '附件.png'] }]);
  assert.equal(h.timers.size, 0);
});
test('edits during upload are retained and never run concurrently', async () => {
  const jobs = []; let finish;
  const h = harness(job => { jobs.push(job); return new Promise(resolve => finish = resolve); });
  h.queue.add('a.md'); await h.fire();
  h.queue.add('a.md'); h.queue.add('b.md');
  assert.equal(h.timers.size, 0); assert.equal(jobs.length, 1);
  finish(); await flush(); await h.fire();
  assert.equal(jobs.length, 2); assert.deepEqual(jobs[1].paths, ['a.md', 'b.md']);
  assert.ok(!h.reports.some(([status]) => status === '已同步'));
  finish(); await flush(); assert.equal(h.timers.size, 0);
  assert.equal(h.reports.at(-1)[0], '已同步');
});
test('initial full sync is once; closing during a transfer aborts and prevents retries', async () => {
  let signal; const h = harness((job, s) => {
    assert.equal(job.full, true); signal = s;
    return new Promise((resolve, reject) => s.addEventListener('abort', () => reject(new Error('stopped'))));
  });
  h.queue.requestFull(); await h.fire(); h.queue.stop(); await flush();
  assert.equal(signal.aborted, true); assert.equal(h.timers.size, 0);
  h.queue.add('x.md'); h.queue.requestFull(); assert.equal(h.timers.size, 0);
});
test('offline retries are bounded; new edit resumes retained failed batch', async () => {
  const jobs = []; const h = harness(async job => { jobs.push(job); throw new Error('offline'); }, { maxRetries: 2 });
  h.queue.add('a.md'); await h.fire(); await h.fire(); await h.fire();
  assert.equal(jobs.length, 3); assert.equal(h.timers.size, 0);
  assert.ok(h.queue.pending.has('a.md'));
  h.queue.add('b.md'); assert.equal(h.timers.size, 1); await h.fire();
  assert.deepEqual(jobs[3].paths.sort(), ['a.md', 'b.md']); h.queue.stop();
});
test('delete/rename of pending directory removes old paths', async () => {
  const jobs = []; const h = harness(async job => jobs.push(job));
  h.queue.add('old/a.md'); h.queue.add('old/b.md'); h.queue.add('other.md');
  h.queue.forget('old'); h.queue.add('new/a.md'); h.queue.add('new/b.md');
  await h.fire(); assert.deepEqual(jobs[0].paths, ['other.md', 'new/a.md', 'new/b.md']);
});
test('closing before debounce cancels upload', async () => {
  let count = 0; const h = harness(async () => count++);
  h.queue.add('x.md'); h.queue.stop(); await flush();
  assert.equal(h.timers.size, 0); assert.equal(count, 0);
});

// Load the actual plugin in a small Obsidian host mock to verify lifecycle wiring.
test('plugin binds vault events only while enabled and kills rclone on unload', async () => {
  const vm = require('node:vm'); const fs = require('node:fs'); const { EventEmitter } = require('node:events');
  const root = path.resolve(__dirname, '..');
  class TFile { constructor(p) { this.path = p; } }
  class Adapter { getBasePath() { return root; } }
  const handlers = {}; let ready; let beforeUnload; let spawned; let killed = false;
  class Plugin {
    async loadData() { return { enabled: true, rclonePath: 'C:\\Tools\\rclone\\rclone.exe' }; }
    addStatusBarItem() { return { setText() {}, setAttribute() {}, createEl() {
      return { setText() {}, setAttribute() {}, removeAttribute() {}, style: {}, value: 0, hidden: false };
    } }; }
    addSettingTab() {} addCommand() {} registerEvent() {}
    registerDomEvent(win, evt, fn) { beforeUnload = fn; }
  }
  const stubFs = { access: async () => {} };
  const fakeQueue = class { constructor(o) { Object.assign(this, o); this.added = []; } requestFull() { this.full = true; } stop() { this.stopped = true; } add(p) { this.added.push(p); } forget() {} };
  const sandbox = { module: { exports: {} }, window: {}, AbortController,
    require: name => {
      if (name === 'obsidian') return { Plugin, PluginSettingTab: class {}, Setting: class {}, Notice: class {}, FileSystemAdapter: Adapter, TFile };
      if (name.endsWith('sync-core.js')) return { included, copyArguments, SyncQueue: fakeQueue };
      if (name === 'node:fs/promises') return stubFs;
      if (name === 'node:child_process') return { spawn: (exe, args, options) => {
        const child = new EventEmitter(); child.stderr = new EventEmitter();
        child.kill = () => { killed = true; setImmediate(() => child.emit('close', null)); };
        spawned = { exe, args, options, child }; return child;
      }};
      return require(name);
    }};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), sandbox);
  const plugin = new sandbox.module.exports();
  plugin.manifest = { id: 'obsidian-gdrive-on-open', dir: '' };
  plugin.app = { vault: { adapter: new Adapter(), configDir: '.obsidian', getFiles: () => [],
    on: (event, fn) => { handlers[event] = fn; return {}; } },
    workspace: { on: (event, fn) => { handlers[event] = fn; return {}; }, onLayoutReady: fn => ready = fn } };
  await plugin.onload(); ready(); assert.equal(plugin.queue.full, true);
  assert.equal(plugin.settings.vaultPath, root);
  handlers.modify(new TFile('中文.md')); assert.deepEqual(plugin.queue.added, ['中文.md']);
  handlers.modify(new TFile('.obsidian/secret.json')); assert.equal(plugin.queue.added.length, 1);
  const task = plugin.upload({ full: true, paths: [] }, new AbortController().signal).catch(e => e);
  await flush(); assert.equal(spawned.options.shell, false); assert.equal(spawned.options.windowsHide, true);
  assert.equal(spawned.args[0], 'copy'); beforeUnload(); await task;
  assert.equal(killed, true); assert.equal(plugin.closed, true); assert.equal(plugin.queue, null);
});
