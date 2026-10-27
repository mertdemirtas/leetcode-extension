'use strict';
// Two complete IDE launches, with a unique extension identity and dummy credentials.
const fs = require('node:fs/promises');
const sync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

(async () => {
  const host = process.env.SINGULARITY_ROOT;
  if (!host) throw new Error('Set SINGULARITY_ROOT to the Singularity directory.');
  const puppeteer = await import(pathToFileURL(path.join(host, 'node_modules/puppeteer/lib/puppeteer/puppeteer.js')).href);
  const source = path.resolve(__dirname, '..');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-session-'));
  const id = 'leetcode-host-checks.' + path.basename(temporary).toLowerCase();
  const config = path.join(temporary, 'config'), project = path.join(temporary, 'project');
  const plugin = path.join(config, 'deployedPlugins', `${id}@0.0.1`, 'extension');
  const fixture = path.join(config, 'deployedPlugins', 'test.session-launcher@0.0.1', 'extension');
  await fs.mkdir(plugin, { recursive: true }); await fs.mkdir(fixture, { recursive: true }); await fs.mkdir(project);
  await fs.writeFile(path.join(config, 'settings.json'), JSON.stringify({ 'security.workspace.trust.trustedFolders': [pathToFileURL(project).href], 'telemetry.telemetryLevel': 'off' }));
  await fs.writeFile(path.join(config, 'recentworkspace.json'), JSON.stringify({ recentRoots: [pathToFileURL(project).href] }));
  for (const folder of ['src', 'media']) await fs.cp(path.join(source, folder), path.join(plugin, folder), { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
  manifest.publisher = 'leetcode-host-checks'; manifest.name = path.basename(temporary).toLowerCase(); manifest.version = '0.0.1';
  await fs.writeFile(path.join(plugin, 'package.json'), JSON.stringify(manifest));
  for (const target of [plugin, fixture]) await fs.writeFile(path.join(target, '../extension.vsixmanifest'), '<PackageManifest/>');
  const entry = path.join(plugin, 'src/extension.cjs');
  const original = await fs.readFile(entry, 'utf8');
  const instrumented = original.replace('  const controller = new Controller(context, journal);', `  const controller = new Controller(context, journal);
  controller.client.fetch = async (_url, request) => {
    const query = JSON.parse(request.body).query;
    const data = query.includes('userStatus') ? {userStatus:{isSignedIn:true,username:'persistent-fixture'}} : {problemsetQuestionList:{total:0,questions:[]}};
    return {ok:true,text:async()=>JSON.stringify({data})};
  };`).replace("return { status: 'ready' };", 'return { controller };');
  assert.notEqual(instrumented, original); await fs.writeFile(entry, instrumented);
  await fs.writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name: 'session-launcher', publisher: 'test', version: '0.0.1', engines: { vscode: '^1.95.0' }, main: 'index.cjs', activationEvents: ['*'] }));
  const first = path.join(temporary, 'first.json'), second = path.join(temporary, 'second.json');
  await fs.writeFile(path.join(fixture, 'index.cjs'), `
    const v=require('vscode'), fs=require('node:fs'), assert=require('node:assert/strict');
    exports.activate=async()=>{
      const report=fs.existsSync(${JSON.stringify(first)})?${JSON.stringify(second)}:${JSON.stringify(first)};
      try{
        const {controller}=await v.extensions.getExtension(${JSON.stringify(id)}).activate();
        const end=Date.now()+20000;
        while(controller.restoring&&Date.now()<end)await new Promise(r=>setTimeout(r,20));
        assert.equal(Boolean(controller.restoring),false);
        if(report===${JSON.stringify(first)}){
          await controller.client.connect({session:'dummy-persistence-session',csrf:'dummy-persistence-csrf'});
          assert.equal((await controller.client.credentials()).session,'dummy-persistence-session');
        }else{
          assert.equal(controller.connection.status,'connected');
          assert.equal(controller.connection.username,'persistent-fixture');
          assert.equal((await controller.client.credentials()).session,'dummy-persistence-session');
          await controller.client.disconnect();
        }
        fs.writeFileSync(report,JSON.stringify({passed:true,restored:report===${JSON.stringify(second)}}));
      }catch(error){fs.writeFileSync(report,JSON.stringify({passed:false,error:error.message}));}
    };
  `);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function round(report) {
    const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    const log = sync.createWriteStream(path.join(temporary, path.basename(report) + '.log'));
    const child = spawn(process.execPath, ['scripts/launch-desktop.cjs', `--user-data-dir=${path.join(temporary, 'profile')}`, `--remote-debugging-port=${port}`, '--ozone-platform=x11', '--disable-gpu'], { cwd: host, env: { ...process.env, THEIA_CONFIG_DIR: config }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log); child.stderr.pipe(log);
    let browser, backendPid;
    try {
      const deadline = Date.now() + 90000;
      while (!sync.existsSync(report) && Date.now() < deadline) { if (child.exitCode !== null || child.signalCode) throw new Error('The isolated IDE exited before the session check.'); await pause(200); }
      assert.ok(sync.existsSync(report), 'Session check timed out: ' + temporary);
      const result = JSON.parse(await fs.readFile(report, 'utf8')); assert.equal(result.passed, true, result.error);
      browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
      const session = await browser.target().createCDPSession();
      const info = await session.send('SystemInfo.getProcessInfo');
      const mainPid = info.processInfo.find(item => item.type === 'browser')?.id;
      if (mainPid && process.platform === 'linux') {
        for (const pid of (await fs.readFile(`/proc/${mainPid}/task/${mainPid}/children`, 'utf8')).trim().split(/\s+/)) {
          try { if ((await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).includes('backend-process.cjs')) backendPid = Number(pid); } catch {}
        }
      }
    } finally {
      browser?.disconnect();
      if (backendPid) { try { process.kill(-backendPid, 'SIGTERM'); } catch {} }
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      log.end();
      const end = Date.now() + 5000;
      while (child.exitCode === null && !child.signalCode && Date.now() < end) await pause(50);
    }
  }
  await round(first); await round(second);
  assert.equal(JSON.parse(await fs.readFile(second, 'utf8')).restored, true);
  console.log('Session persistence passed across two complete IDE launches. Dummy credentials used a unique extension identity and were deleted after verification.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
