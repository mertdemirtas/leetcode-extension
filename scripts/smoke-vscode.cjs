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
      controller.client.submissions=async()=>({submissions:[['1042839576',10,'Accepted'],['1042839577',0,'Pending'],['1042839578',11,'Wrong Answer'],['1042839579',14,'Time Limit Exceeded']].map(([id,status,statusDisplay])=>({id,titleSlug:'two-sum',title:'Two Sum',lang:'python3',status,statusDisplay,isPending:status===0?'Pending':'Not Pending',runtime:'3 ms',memory:'19.2 MB',timestamp:'1793057511'})),hasNext:false,lastKey:null});
      controller.client.submissionStatus=async()=>({statusCode:10,question:{titleSlug:'two-sum'},user:{username:'fixture-account'}});
      controller.client.submissionDetails=async id=>({code:id==='1042839577'?'# Website submission fixture':problem.codeSnippets[0].code,statusCode:10,runtime:3,runtimeDisplay:'3 ms',runtimePercentile:91.8,runtimeDistribution:JSON.stringify({distribution:[[1,10],[2,20],[3,40],[4,20],[5,10]]}),memory:19200000,memoryDisplay:'19.2 MB',memoryPercentile:82.4,memoryDistribution:JSON.stringify({distribution:[[18000,10],[19000,40],[20000,30],[21000,20]]}),totalCorrect:63,totalTestcases:63,lang:{name:'python3'},question:{titleSlug:'two-sum'},user:{username:'fixture-account'}});

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
      controller.browser={questions:[{...problem,status:'ac'}],total:1,search:'',loading:false,error:null};
      await v.commands.executeCommand('workbench.action.closeAuxiliaryBar').catch(()=>{});
      await v.commands.executeCommand('singularityLeetcode.open');
      await controller.openProblem('two-sum');
      assert.ok((await v.commands.getCommands(true)).includes('singularityLeetcode.selectLanguage'));
      await controller.context.secrets.store('leetcode.host-smoke','fixture-only');
      assert.equal(await controller.context.secrets.get('leetcode.host-smoke'),'fixture-only');
      await controller.context.secrets.delete('leetcode.host-smoke');
      await v.commands.executeCommand('singularityLeetcode.run');
      assert.equal(controller.state().record.result.verdict,'All tests passed');
      assert.equal(controller.state().record.remoteId,'runcode_1627219627.5662382_EI7iasnhLm');
      await v.commands.executeCommand('singularityLeetcode.submit');
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
      await controller.loadHistory();
      assert.equal(controller.state().history.length,4);
      assert.ok(controller.state().history.every(record=>record.kind==='submit'&&record.status==='complete'));
      await controller.message({type:'snapshot',id:'submission:1042839577'});
      assert.ok(v.workspace.textDocuments.some(document=>document.getText()==='# Website submission fixture'));
      await controller.openProblem('two-sum');
      await controller.message({type:'selectAttempt',id:'submission:1042839577'});
      await controller.showResults();
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
    async function modeFrame(mode) {
      const end=Date.now()+15000;
      while(Date.now()<end){
        for(const frame of page.frames()){
          if(!frame.parentFrame())continue;
          try{
            const owners=[];
            for(let current=frame;current.parentFrame();current=current.parentFrame())owners.unshift(await current.frameElement());
            let visible=true;
            for(const owner of owners)if(!await owner.isVisible()){visible=false;break;}
            for(const owner of owners)await owner.dispose();
            if(visible&&await frame.$(`body[data-mode="${mode}"]`))return frame;
          }catch{}
        }
        await pause(100);
      }
      throw new Error('Missing visible '+mode+' webview');
    }
    const resultFrame=await modeFrame('results');
    const found=await resultFrame.$('h2');
    assert.ok(found,'Results webview must render after restoration');
    const text=await found.evaluate(element=>element.textContent);assert.equal(text,'Accepted');
    const charts = await found.evaluate(element => element.ownerDocument.querySelectorAll('svg.distribution-chart').length);
    assert.equal(charts, 2);
    const descriptionFrame=await modeFrame('description');
    assert.ok(descriptionFrame, 'The statement must remain beside the native solution editor');
    assert.equal((await descriptionFrame.$$('.workbench-toolbar,[data-action="run"],[data-action="submit"]')).length,0);
    await page.screenshot({path:path.join(source,'test-artifacts/vscode-before-native.png'),fullPage:true});
    await page.screenshot({path:path.join(source,'test-artifacts/vscode-orbit.png'),fullPage:true});
    await resultFrame.click('[data-tab="history"]');
    await resultFrame.waitForFunction(() => document.querySelectorAll('.history tbody tr').length===4);
    const verdicts=await resultFrame.$$eval('.history tbody tr td:first-child button',nodes=>nodes.map(node=>node.textContent).sort());
    assert.deepEqual(verdicts,['Accepted','Accepted','Time Limit Exceeded','Wrong Answer']);
    await page.screenshot({path:path.join(source,'test-artifacts/vscode-history.png'),fullPage:true});
    await resultFrame.click('[data-action="submissionPerformance"][data-id="submission:1042839577"]');
    await pause(500);
    await resultFrame.waitForFunction(()=>document.querySelectorAll('.submission-performance svg.distribution-chart').length===2&&!document.querySelector('.performance-status[role="status"]'),{polling:100,timeout:10000});
    assert.equal(await resultFrame.$eval('[data-tab="history"]',element=>element.getAttribute('aria-selected')),'true');
    await page.screenshot({path:path.join(source,'test-artifacts/vscode-history-performance.png'),fullPage:true});
    await resultFrame.click('[data-action="selectAttempt"][data-id="submission:1042839577"]');
    await resultFrame.waitForSelector('svg.distribution-chart');

    assert.deepEqual(await fs.readdir(saved), ['two-sum.py']);
    await page.screenshot({path:path.join(source,'test-artifacts/vscode.png'),fullPage:true});
    console.log('VS Code host checks passed (including a simulated browser authorization callback): activation, secure storage, native files, flat save path without JSON sidecars, dotted run IDs, run, submit, and toggling the panel and reopening the rendered Accepted result after a native close. Judge data was simulated.');
  }finally{if(browser)browser.disconnect();try{process.kill(-child.pid,'SIGTERM');}catch{}log.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
