'use strict';
// Exercises an isolated VS Code development host using controlled judge fixtures.
const fs = require('node:fs/promises');
const sync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

(async () => {
  const executable = process.env.VSCODE_EXECUTABLE;
  if (!executable || !process.env.SINGULARITY_ROOT) throw new Error('Set VSCODE_EXECUTABLE and SINGULARITY_ROOT (for its Puppeteer runtime).');
  const puppeteer = await import(pathToFileURL(path.join(process.env.SINGULARITY_ROOT, 'node_modules/puppeteer/lib/puppeteer/puppeteer.js')).href);
  const source = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-vscode-'));
  const testExtensionId = 'leetcode-host-checks.' + path.basename(temp).toLowerCase();
  const plugin = path.join(temp, 'extension'), fixture = path.join(temp, 'fixture'), project = path.join(temp, 'project'), saved = path.join(temp, 'saved-problems');
  await fs.mkdir(plugin); await fs.mkdir(fixture); await fs.mkdir(path.join(project, '.vscode'), { recursive: true });
  await fs.writeFile(path.join(project, '.vscode/settings.json'), JSON.stringify({ 'singularityLeetcode.savePath': saved, 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none' }));
  for (const file of ['src','media','package.json']) await fs.cp(path.join(source, file), path.join(plugin, file), { recursive: true });
  const isolatedManifest = JSON.parse(await fs.readFile(path.join(plugin, 'package.json'), 'utf8'));
  isolatedManifest.publisher = 'leetcode-host-checks'; isolatedManifest.name = path.basename(temp).toLowerCase();
  await fs.writeFile(path.join(plugin, 'package.json'), JSON.stringify(isolatedManifest));
  const entry = path.join(plugin, 'src/extension.cjs');
  const original = await fs.readFile(entry, 'utf8');
  const instrumented = original.replace("return { status: 'ready' };", 'return { controller };');
  assert.notEqual(instrumented, original); await fs.writeFile(entry, instrumented);
  await fs.writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name:'leetcode-host-test', publisher:'test', version:'0.0.1', engines:{vscode:'^1.95.0'}, activationEvents:['*'], main:'index.cjs' }));
  const report = path.join(temp, 'report.json');
  const data = require('../test/ui-fixture.cjs')();
  const problem = { ...data.problem, sampleTestCase: '[2,7,11,15]\n9', metaData: '{"params":[{},{}]}', codeSnippets: [{ lang:'Python3', langSlug:'python3', code:'class Solution:\n    def twoSum(self, nums, target):\n        return [0, 1]' }] };
  await fs.writeFile(path.join(fixture, 'index.cjs'), `
    const v=require('vscode'), fs=require('node:fs'), assert=require('node:assert/strict');
    exports.activate=async()=>{try{
      const {controller}=await v.extensions.getExtension(${JSON.stringify(testExtensionId)}).activate();
      while(controller.restoring)await new Promise(resolve=>setTimeout(resolve,10));
      const problem=${JSON.stringify(problem)}; let posts=0;
      controller.client.problem=async()=>problem;
      const judgeResult={state:'SUCCESS',status_code:10,correct_answer:true,compare_result:'1',code_answer:['[0,1]'],expected_code_answer:['[0,1]'],status_runtime:'3 ms',status_memory:'19.2 MB',total_correct:63,total_testcases:63};
      controller.openSignInUrl=async url=>{
        const authorization=new URL(url);
        assert.equal(authorization.pathname,'/authorize-login/'+v.env.uriScheme+'/');
        const target=v.Uri.parse(v.env.uriScheme+'://'+authorization.searchParams.get('path')+'?'+new URLSearchParams({cookie:'LEETCODE_SESSION=fixture-session; csrftoken=fixture-csrf'}));
        assert.equal(controller.browserAuth.handleUri(target),true);
        return true;
      };
      controller.client.fetch=async(url,request)=>{
        let result;
        if(url.endsWith('/graphql/'))result={data:{userStatus:{isSignedIn:true,username:'fixture-account'}}};
        else if(url.endsWith('/interpret_solution/')){posts++;result={interpret_id:'runcode_1627219627.5662382_EI7iasnhLm'};}
        else if(url.endsWith('/submit/')){posts++;result={submission_id:1042839576};}
        else{assert.match(url,/\\/submissions\\/detail\\/(runcode_1627219627\\.5662382_EI7iasnhLm|1042839576)\\/check\\/$/);assert.equal(request.method,'GET');result=judgeResult;}
        return{ok:true,text:async()=>JSON.stringify(result)};
      };
      const credentials=await controller.browserSignIn();
      const account=await controller.client.connect(credentials);
      assert.equal((await controller.client.credentials()).session,'fixture-session');
      controller.connection={status:'connected',...account};
      await v.commands.executeCommand('workbench.action.closeAuxiliaryBar').catch(()=>{});
      await v.commands.executeCommand('singularityLeetcode.open');
      await controller.openProblem('two-sum');
      await controller.context.secrets.store('leetcode.host-smoke','fixture-only');
      assert.equal(await controller.context.secrets.get('leetcode.host-smoke'),'fixture-only');
      await controller.context.secrets.delete('leetcode.host-smoke');
      await controller.execute('run');
      assert.equal(controller.state().record.result.verdict,'All tests passed');
      assert.equal(controller.state().record.remoteId,'runcode_1627219627.5662382_EI7iasnhLm');
      await controller.execute('submit');
      assert.equal(controller.state().record.result.verdict,'Accepted');
      await v.commands.executeCommand('singularityLeetcode.toggleResults');
      while(controller.views.get('results')?.visible)await new Promise(resolve=>setTimeout(resolve,10));
      await v.commands.executeCommand('singularityLeetcode.toggleResults');
      while(!controller.views.get('results')?.visible)await new Promise(resolve=>setTimeout(resolve,10));
      await v.commands.executeCommand('workbench.action.closePanel');
      while(controller.views.get('results')?.visible)await new Promise(resolve=>setTimeout(resolve,10));
      await v.commands.executeCommand('singularityLeetcode.toggleResults');
      assert.equal(controller.state().record.result.verdict,'Accepted');
      assert.equal(posts,2);
      fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({passed:true,posts,state:controller.state()}));
    }catch(error){fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({passed:false,error:error.stack}));}};
  `);
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0,'127.0.0.1',resolve));
  const port = socket.address().port; await new Promise(resolve=>socket.close(resolve));
  const log = sync.createWriteStream(path.join(temp,'host.log'));
  const environment = { ...process.env };
  // Running an installed Snap binary directly needs host GTK/GIO libraries, not the launcher’s core20 paths.
  if (executable.startsWith('/snap/')) {
    environment.LD_LIBRARY_PATH = '/usr/lib/x86_64-linux-gnu';
    environment.GSETTINGS_SCHEMA_DIR = '/usr/share/glib-2.0/schemas';
    environment.GIO_MODULE_DIR = '/usr/lib/x86_64-linux-gnu/gio/modules';
    environment.CHROME_DEVEL_SANDBOX = '/opt/google/chrome/chrome-sandbox';
  }
  const args = [`--user-data-dir=${path.join(temp,'profile')}`,`--extensions-dir=${path.join(temp,'extensions')}`,`--extensionDevelopmentPath=${plugin}`,`--extensionDevelopmentPath=${fixture}`,`--remote-debugging-port=${port}`,'--disable-workspace-trust','--skip-welcome','--skip-release-notes','--new-window','--disable-gpu',project];
  const loader = process.env.VSCODE_LOADER;
  const child = spawn(loader || executable,loader ? ['--library-path','/usr/lib/x86_64-linux-gnu',executable,...args] : args,{env:environment,detached:true,stdio:['ignore','pipe','pipe']});
  child.stdout.pipe(log);child.stderr.pipe(log);
  console.log(`Isolated VS Code profile: ${temp}`);
  let browser;
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  try {
    const deadline=Date.now()+90000;
    while(!sync.existsSync(report)&&Date.now()<deadline){if(child.exitCode!==null||child.signalCode)throw new Error(`VS Code exited during launch. See ${path.join(temp,'host.log')}`);await pause(250);}
    if(!sync.existsSync(report))throw new Error(`VS Code host timed out. See ${path.join(temp,'host.log')}`);
    const result=JSON.parse(await fs.readFile(report,'utf8'));assert.equal(result.passed,true,result.error);
    browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:null,protocolTimeout:20000});
    const page=await(await browser.waitForTarget(target=>target.type()==='page')).page();
    let found;
    const end=Date.now()+15000;
    while(!found&&Date.now()<end){for(const frame of page.frames()){try{found=await frame.$('body[data-mode="results"] h2');if(found)break;}catch{}}if(!found)await pause(100);}
    assert.ok(found,'Results webview must render after restoration');
    const text=await found.evaluate(element=>element.textContent);assert.equal(text,'Accepted');
    assert.deepEqual(await fs.readdir(saved), ['two-sum.py']);
    await page.screenshot({path:path.join(source,'test-artifacts/vscode.png'),fullPage:true});
    console.log('VS Code host checks passed (including a simulated browser authorization callback): activation, secure storage, native files, flat save path without JSON sidecars, dotted run IDs, run, submit, and toggling the panel and reopening the rendered Accepted result after a native close. Judge data was simulated.');
  }finally{if(browser)browser.disconnect();try{process.kill(-child.pid,'SIGTERM');}catch{}log.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
