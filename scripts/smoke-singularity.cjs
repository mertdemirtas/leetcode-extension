'use strict';
// Uses a separate Singularity profile. Judge responses are fixtures; no real account or submission is used.
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
  if (!host) throw new Error('Set SINGULARITY_ROOT to the Singularity source/build directory.');
  const puppeteer = await import(pathToFileURL(path.join(host, 'node_modules/puppeteer/lib/puppeteer/puppeteer.js')).href);
  const source = path.resolve(__dirname, '..');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-singularity-'));
  const config = path.join(temporary, 'config'), project = path.join(temporary, 'project'), savePath = path.join(temporary, 'problems');
  await fs.mkdir(config); await fs.mkdir(project);
  await fs.writeFile(path.join(config, 'settings.json'), JSON.stringify({ 'files.autoSave': 'off', 'telemetry.telemetryLevel': 'off', 'singularityLeetcode.savePath': savePath, 'security.workspace.trust.trustedFolders': [pathToFileURL(project).href] }));
  await fs.writeFile(path.join(config, 'recentworkspace.json'), JSON.stringify({ recentRoots: [pathToFileURL(project).href] }));
  const testExtensionId = 'leetcode-host-checks.' + path.basename(temporary).toLowerCase();
  const plugin = path.join(config, `deployedPlugins/${testExtensionId}@${require('../package.json').version}/extension`);
  await fs.mkdir(plugin, { recursive: true });
  for (const name of ['src', 'media', 'package.json']) await fs.cp(path.join(source, name), path.join(plugin, name), { recursive: true });
  const isolatedManifest = JSON.parse(await fs.readFile(path.join(plugin, 'package.json'), 'utf8'));
  isolatedManifest.publisher = 'leetcode-host-checks'; isolatedManifest.name = path.basename(temporary).toLowerCase();
  await fs.writeFile(path.join(plugin, 'package.json'), JSON.stringify(isolatedManifest));
  await fs.writeFile(path.join(plugin, '../extension.vsixmanifest'), '<PackageManifest/>');
  if (process.env.LEETCODE_OLD_EXTENSION) {
    const oldManifest = JSON.parse(await fs.readFile(path.join(process.env.LEETCODE_OLD_EXTENSION, 'package.json'), 'utf8'));
    const oldPlugin = path.join(config, `deployedPlugins/${testExtensionId}@${oldManifest.version}/extension`);
    await fs.cp(process.env.LEETCODE_OLD_EXTENSION, oldPlugin, { recursive: true });
    oldManifest.publisher = isolatedManifest.publisher; oldManifest.name = isolatedManifest.name;
    await fs.writeFile(path.join(oldPlugin, 'package.json'), JSON.stringify(oldManifest));
    await fs.writeFile(path.join(oldPlugin, '../extension.vsixmanifest'), '<PackageManifest/>');
  }
  const entry = path.join(plugin, 'src/extension.cjs');
  const original = await fs.readFile(entry, 'utf8');
  // Expose the controller only in this disposable instrumented copy, never in the shipped extension.
  const instrumented = original.replace("return { status: 'ready' };", 'return { controller };');
  assert.notEqual(instrumented, original); await fs.writeFile(entry, instrumented);
  const fixture = path.join(config, 'deployedPlugins/test.leetcode-fixture@0.0.1/extension');
  await fs.mkdir(fixture, { recursive: true });
  await fs.writeFile(path.join(fixture, '../extension.vsixmanifest'), '<PackageManifest/>');
  await fs.writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name: 'leetcode-fixture', publisher: 'test', version: '0.0.1', engines: { vscode: '^1.85.0' }, main: 'index.cjs', activationEvents: ['*'] }));
  await fs.writeFile(path.join(fixture, 'index.cjs'), `
    const v = require('vscode'); const assert = require('node:assert/strict'); let controller; let posts=0;
    exports.activate = context => context.subscriptions.push(v.commands.registerCommand('test.leetcode.action', async action => {
      if (action === 'seed') {
        const extension = v.extensions.getExtension(${JSON.stringify(testExtensionId)});
        if (!extension) throw new Error('LeetCode extension was not deployed');
        assert.equal(extension.packageJSON.version, ${JSON.stringify(require('../package.json').version)});
        ({ controller } = await extension.activate());
        while (controller.restoring) await new Promise(resolve => setTimeout(resolve, 10));
        const problem = { questionId:'1', questionFrontendId:'1', title:'Two Sum', titleSlug:'two-sum', difficulty:'Easy', topicTags:[{name:'Array'},{name:'Hash table'}], content:'<p>Find two indices whose numbers add up to target.</p><pre>Input: nums = [2,7,11,15], target = 9\\nOutput: [0,1]</pre>', sampleTestCase:'[2,7,11,15]\\n9', metaData:JSON.stringify({params:[{},{}]}), codeSnippets:[{lang:'Python3',langSlug:'python3',code:'class Solution:\\n    def twoSum(self, nums, target):\\n        seen = {}\\n        for i, n in enumerate(nums):\\n            if target - n in seen:\\n                return [seen[target - n], i]\\n            seen[n] = i'}] };
        controller.client.problem = async () => problem;
      controller.client.submissions=async()=>({submissions:[['1042839576',10,'Accepted'],['1042839577',0,'Pending'],['1042839578',11,'Wrong Answer'],['1042839579',14,'Time Limit Exceeded']].map(([id,status,statusDisplay])=>({id,titleSlug:'two-sum',title:'Two Sum',lang:'python3',status,statusDisplay,isPending:status===0?'Pending':'Not Pending',runtime:'3 ms',memory:'19.2 MB',timestamp:'1793057511'})),hasNext:false,lastKey:null});
      controller.client.submissionStatus=async()=>({statusCode:10,question:{titleSlug:'two-sum'},user:{username:'fixture-account'}});
      controller.client.submissionDetails=async id=>({code:id==='1042839577'?'# Website submission fixture':problem.codeSnippets[0].code,statusCode:10,runtime:3,runtimeDisplay:'3 ms',runtimePercentile:91.8,runtimeDistribution:JSON.stringify({distribution:[[1,10],[2,20],[3,40],[4,20],[5,10]]}),memory:19200000,memoryDisplay:'19.2 MB',memoryPercentile:82.4,memoryDistribution:JSON.stringify({distribution:[[18000,10],[19000,40],[20000,30],[21000,20]]}),totalCorrect:63,totalTestcases:63,lang:{name:'python3'},question:{titleSlug:'two-sum'},user:{username:'fixture-account'}});

        const judgeResult = {state:'SUCCESS',status_code:10,correct_answer:true,compare_result:'1',code_answer:['[0,1]'],expected_code_answer:['[0,1]'],status_runtime:'3 ms',status_memory:'19.2 MB',runtime_percentile:91.8,memory_percentile:82.4,total_correct:63,total_testcases:63};
        controller.openSignInUrl = async url => {
          const authorization = new URL(url);
          assert.equal(authorization.pathname, '/authorize-login/http/');
          const target = new URL('http://' + authorization.searchParams.get('path'));
          target.searchParams.set('cookie', 'LEETCODE_SESSION=fixture-session; csrftoken=fixture-csrf');
          const response = await fetch(target);
          assert.equal(response.status, 200);
          assert.match(await response.text(), /Return to your IDE/);
          return true;
        };
        controller.client.fetch = async (url, request) => {
          let result;
          if (url.endsWith('/graphql/')) result = {data:{userStatus:{isSignedIn:true,username:'fixture-account'}}};
          else if (url.endsWith('/interpret_solution/')) { posts++; result = {interpret_id:'runcode_1627219627.5662382_EI7iasnhLm'}; }
          else if (url.endsWith('/submit/')) { posts++; result = {submission_id:1042839576}; }
          else {
            assert.match(url, /\\/submissions\\/detail\\/(runcode_1627219627\\.5662382_EI7iasnhLm|1042839576)\\/check\\/$/);
            assert.equal(request.method, 'GET'); result = judgeResult;
          }
          return {ok:true,text:async()=>JSON.stringify(result)};
        };
        const credentials = await controller.browserSignIn();
        const account = await controller.client.connect(credentials);
        assert.equal((await controller.client.credentials()).session, 'fixture-session');
        controller.connection = { status:'connected', ...account };
        controller.browser = {questions:[{...problem,status:'ac'}],total:1,search:'',loading:false,error:null};
        await controller.openProblem('two-sum');
      } else if (action === 'history') await controller.loadHistory();
      else if (action === 'snapshot') await controller.message({type:'snapshot',id:'submission:1042839577'});
      else if (action === 'select') await controller.message({type:'selectAttempt',id:'submission:1042839577'});
      else if (action === 'submit') await controller.execute('submit');
      else if (action === 'show') await controller.showResults();
      else if (action === 'minimize') await controller.minimize();
      else if (action === 'toggle') await v.commands.executeCommand('singularityLeetcode.toggleResults');
      else if (action === 'run') await controller.execute('run');
      return {state:controller?.state(),posts};
    }));
  `);
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const logFile = path.join(temporary, 'host.log'); const log = sync.createWriteStream(logFile);
  const child = spawn(process.execPath, ['scripts/launch-desktop.cjs', `--user-data-dir=${path.join(temporary, 'profile')}`, `--remote-debugging-port=${port}`, '--ozone-platform=x11', '--disable-gpu'], { cwd: host, env: { ...process.env, THEIA_CONFIG_DIR: config }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log); child.stderr.pipe(log);
  console.log(`Isolated profile: ${temporary}`);
  let browser, backendPid;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(fn, label, timeout = 60000) {
    const end = Date.now() + timeout; let lastError;
    while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch (error) { lastError = error; } await pause(250); }
    throw new Error(`Timed out: ${label}${lastError ? ` (${lastError.message})` : ''}. Log: ${logFile}`);
  }
  try {
    browser = await until(() => puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null, protocolTimeout: 20000 }), 'Singularity launch');
    const session = await browser.target().createCDPSession();
    const { processInfo } = await session.send('SystemInfo.getProcessInfo');
    const mainPid = processInfo.find(process => process.type === 'browser')?.id;
    if (process.platform === 'linux' && mainPid) {
      const children = (await fs.readFile(`/proc/${mainPid}/task/${mainPid}/children`, 'utf8')).trim().split(/\s+/);
      for (const pid of children) { try { if ((await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).includes('backend-process.cjs')) backendPid = Number(pid); } catch {} }
    }
    const page = await (await browser.waitForTarget(target => target.type() === 'page', { timeout: 30000 })).page();
    await page.waitForSelector('body.plain-session-ready #plain-header', { timeout: 60000 });
    await page.waitForFunction(() => [...theia.container._bindingDictionary._map.values()].flat().some(binding => binding.cache?._state === 'ready'), { timeout: 60000 });
    await page.evaluate(() => {
      const values = [...theia.container._bindingDictionary._map.values()].flat().map(binding => binding.cache);
      window.fixtureCommands = values.find(value => Object.keys(value || {}).includes('_commands'));
    });
    const command = action => page.evaluate(action => fixtureCommands.executeCommand('test.leetcode.action', action), action);
    const state = await command('seed');
    assert.equal(state.state.problem.titleSlug, 'two-sum');
    await page.evaluate(() => fixtureCommands.executeCommand('singularityLeetcode.problems.focus'));
    async function modeFrame(mode) {
      return until(async () => {
        for (const frame of page.frames()) { try { if (await frame.$(`body[data-mode="${mode}"] .side-controls,body[data-mode="${mode}"] .result-header,body[data-mode="${mode}"] .description`)) return frame; } catch {} }
      }, `${mode} webview`, 30000);
    }
    const sidebar = await modeFrame('problems');
    assert.equal((await sidebar.$$('.side-controls button')).length, 5);
    const description = await modeFrame('description');
    assert.equal((await description.$$('.workbench-toolbar,[data-action="run"],[data-action="submit"]')).length, 0);
    async function nativeAction(label) {
      const visible = async selector => {
        const handle = await page.evaluateHandle(({selector,label}) => [...document.querySelectorAll(selector)].find(node => (node.getAttribute('title') || node.textContent || '').includes(label) && node.getBoundingClientRect().width > 0), {selector,label});
        const element = handle.asElement(); if (element) return element;
        await handle.dispose();
      };
      let handle = await visible('[title]');
      if (!handle) {
        const more = await until(async () => {
          for (const node of await page.$$('[title="More Actions..."]')) if ((await node.boundingBox())?.width) return node;
        }, 'native More Actions');
        await more.click(); await more.dispose();
        handle = await until(() => visible('.lm-Menu-itemLabel,.p-Menu-itemLabel,[role="menuitem"]'), `native ${label} menu action`, 15000);
      }
      await handle.click(); await handle.dispose();
    }
    const result = await modeFrame('results');
    assert.equal((await result.$$('[data-action="minimize"],[data-action="toggleResults"]')).length, 0);
    await command('toggle');
    await pause(500);
    await until(async () => !(await command('state')).state.resultsVisible, 'hidden results visibility');
    await sidebar.click('[data-action="toggleResults"]');
    const restored = await modeFrame('results');
    await restored.click('[data-tab="cases"]');
    assert.equal((await restored.$$('textarea')).length, 1);
    assert.equal((await restored.$$('[data-field="expected"]')).length, 0);
    await restored.$eval('[data-field="input"]', element => { element.value = '[3,3]\n6'; element.dispatchEvent(new Event('input', { bubbles: true })); });
    await nativeAction('Change Solution Language');
    await page.waitForSelector('.quick-input-widget', { visible: true });
    await page.keyboard.press('Escape');
    await nativeAction('Run Test Cases');
    await until(async () => { const record = (await command('state')).state.record; return record?.kind === 'run' && record?.status === 'complete'; }, 'edited test case run');
    assert.equal((await command('state')).state.record.result.cases[0].input, '[3,3]\n6');
    assert.equal((await command('state')).state.record.remoteId, 'runcode_1627219627.5662382_EI7iasnhLm');
    await nativeAction('Submit Solution');
    await until(async () => (await command('state')).state.record?.result?.accepted, 'accepted judge fixture');
    const current = await command('state'); assert.equal(current.posts, 2);
    assert.equal(current.state.record.result.verdict, 'Accepted');
    await page.screenshot({ path: path.join(source, 'test-artifacts/singularity-orbit.png'), fullPage: true });
    await command('toggle');
    await until(async () => !(await command('state')).state.resultsVisible, 'hide results with toggle');
    await command('toggle');
    assert.equal((await command('state')).state.record.result.verdict, 'Accepted');
    await command('history');
    const history = (await command('state')).state.history;
    assert.equal(history.length, 4); assert.ok(history.every(record => record.kind === 'submit' && record.status === 'complete'));
    const historyFrame = await modeFrame('results');
    await historyFrame.click('[data-tab="history"]');
    await historyFrame.waitForFunction(() => document.querySelectorAll('.history tbody tr').length === 4);
    const verdicts = await historyFrame.$$eval('.history tbody tr td:first-child button', nodes => nodes.map(node => node.textContent).sort());
    assert.deepEqual(verdicts, ['Accepted','Accepted','Time Limit Exceeded','Wrong Answer']);
    await page.screenshot({path:path.join(source,'test-artifacts/singularity-history.png'),fullPage:true});
    const selectedBefore = (await command('state')).state.record.id;
    await historyFrame.click('[data-action="submissionPerformance"][data-id="submission:1042839577"]');
    await historyFrame.waitForFunction(() => document.querySelectorAll('.submission-performance svg.distribution-chart').length===2 && !document.querySelector('.performance-status[role="status"]'));
    assert.equal(await historyFrame.$eval('[data-tab="history"]',element=>element.getAttribute('aria-selected')),'true');
    assert.equal((await command('state')).state.record.id,selectedBefore);
    assert.equal((await command('state')).posts,2);
    await page.screenshot({path:path.join(source,'test-artifacts/singularity-history-performance.png'),fullPage:true});
    await command('snapshot'); await command('select');
    const finalResults = await modeFrame('results');
    await finalResults.waitForSelector('svg.distribution-chart');
    assert.equal((await finalResults.$$('svg.distribution-chart')).length, 2);
    await finalResults.waitForFunction(() => document.querySelector('h2')?.textContent === 'Accepted', { timeout: 15000 });
    assert.deepEqual(await fs.readdir(savePath), ['two-sum.py']);
    const screenshots = path.join(source, 'test-artifacts'); await fs.mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, 'singularity.png'), fullPage: true });
    console.log('Singularity host checks passed: simulated browser authorization through localhost, deployment, activation, native solution editors, sidebar controls, flat save path without JSON sidecars, dotted run IDs, run/submit wiring, and a single toggle hiding and restoring retained results. Judge data was simulated.');
  } finally {
    if (browser) browser.disconnect();
    if (backendPid) { try { process.kill(-backendPid, 'SIGTERM'); } catch {} }
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    log.end();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
