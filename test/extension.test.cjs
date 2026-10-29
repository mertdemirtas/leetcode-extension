'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const sync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { Journal } = require('../src/journal.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-host-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = { savePath: path.join(directory, 'my problems') };
  const calls = [];
  const uri = value => { const parsed = new URL(value); return { scheme: parsed.protocol.slice(0, -1), authority: parsed.host, path: parsed.pathname, query: parsed.search.slice(1), fsPath: parsed.protocol === 'file:' ? fileURLToPath(parsed) : '', toString: () => parsed.href }; };
  const Uri = { file: value => uri(pathToFileURL(value).href), parse: uri, joinPath: (value, ...parts) => Uri.file(path.join(value.fsPath, ...parts)) };
  const disposable = { dispose() {} };
  const api = {
    Uri, ViewColumn: { One: 1, Two: 2 }, ConfigurationTarget: { Global: 1 }, env: { appName: 'Singularity', openExternal: async url => calls.push(['external', url.toString()]) },
    commands: { executeCommand: async (...args) => calls.push(args), getCommands: async () => ['workbench.action.closePanel'] },
    workspace: {
      getConfiguration: () => ({ get: (key, fallback) => config[key] ?? fallback, update: async (key, value) => { config[key] = value; } }),
      openTextDocument: async value => ({ uri: value, getText: () => sync.readFileSync(value.fsPath, 'utf8'), save: async () => true })
    },
    window: {
      createWebviewPanel: (_type, _title, options) => { calls.push(['panel', options]); return { webview: { options: {}, asWebviewUri: value => value.toString(), cspSource: 'vscode-resource:', onDidReceiveMessage: listener => { setTimeout(() => listener({ type: 'ready' }), 0); return disposable; }, postMessage: async message => calls.push(['message', message]) }, reveal: (...args) => calls.push(['reveal', ...args]), onDidDispose: () => disposable, dispose() {} }; },
      showTextDocument: async (_document, options) => calls.push(['editor', options]),
      showOpenDialog: async () => [Uri.file(config.savePath)], showErrorMessage: async message => calls.push(['error', message])
    }
  };
  const file = path.join(__dirname, '../src/extension.cjs');
  const localRequire = createRequire(file);
  const module = { exports: {} };
  vm.runInNewContext('(function(require,module,exports){' + sync.readFileSync(file, 'utf8') + '\n})', { console, structuredClone, setTimeout, clearTimeout, URL })(id => id === 'vscode' ? api : localRequire(id), module, module.exports);
  const journal = new Journal(path.join(directory, 'private')); await journal.load();
  const stored = new Map();
  const workspaceStored = new Map();
  const context = { extension: { id: 'mertdemirtas.singularity-leetcode' }, extensionUri: Uri.file(path.join(__dirname, '..')), workspaceState: { get: key => structuredClone(workspaceStored.get(key)), update: async (key, value) => workspaceStored.set(key, structuredClone(value)) }, secrets: { get: async key => stored.get(key), store: async (key, value) => stored.set(key, value), delete: async key => stored.delete(key) }, subscriptions: [] };
  const controller = new module.exports.Controller(context, journal);
  t.after(() => controller.dispose());
  const problem = { detailsVersion: 1, hints: ['Use a hash map.'], companies: [], companiesAvailable: false, titleSlug: 'two-sum', questionId: '1', questionFrontendId: '1', title: 'Two Sum', difficulty: 'Easy', content: '<p>Find two numbers.</p>', sampleTestCase: '[2,7]\n9', metaData: '{"params":[{},{}]}', topicTags: [], codeSnippets: [{ lang: 'Python3', langSlug: 'python3', code: 'class Solution: pass' }] };
  controller.client.problem = async () => problem;
  return { controller, config, calls, api, directory, problem, html: module.exports.html, context, Controller: module.exports.Controller };
}

test('a problem opens in native editors and uses an absolute save path without a workspace', async t => {
  const { controller, config, calls, context, Controller } = await fixture(t);
  await controller.openProblem('two-sum');
  const solution = path.join(config.savePath, 'two-sum.py');
  assert.equal(await fs.readFile(solution, 'utf8'), 'class Solution: pass\n');
  assert.ok(calls.some(([name, options]) => name === 'editor' && options.viewColumn === 2));
  await fs.writeFile(solution, 'my work');
  await controller.openProblem('two-sum');
  assert.equal(await fs.readFile(solution, 'utf8'), 'my work');
  await controller.updateCases('two-sum', [{ input: '[3,3]\n6', expected: '[0,1]' }]);
  assert.deepEqual(context.workspaceState.get('state.v1').cases['two-sum'][0], { name: 'Case 1', input: '[3,3]\n6' });
  assert.deepEqual(await fs.readdir(config.savePath), ['two-sum.py']);
  const restarted = new Controller(context, controller.journal); t.after(() => restarted.dispose());
  await restarted.openProblem('two-sum');
  assert.equal(restarted.state().cases[0].input, '[3,3]\n6');
  assert.equal(await fs.readFile(solution, 'utf8'), 'my work');
  assert.deepEqual(await fs.readdir(config.savePath), ['two-sum.py']);
});

test('opening a legacy solution saves unsaved edits before copying to a flat filename', async t => {
  const { controller, config, api, context } = await fixture(t);
  const legacy = path.join(config.savePath, 'two-sum'); await fs.mkdir(legacy, { recursive: true });
  const oldFile = path.join(legacy, 'python3.py'); await fs.writeFile(oldFile, 'older disk code');
  const oldCases = '[{"input":"[3,3]\\n6"}]'; await fs.writeFile(path.join(legacy, 'testcases.json'), oldCases);
  const uri = api.Uri.file(oldFile);
  controller.saved.documents[uri.toString()] = { slug: 'two-sum', language: 'python3' };
  api.workspace.textDocuments = [{ uri, isDirty: true, save: async () => { await fs.writeFile(oldFile, 'newest editor code'); return true; } }];
  await controller.openProblem('two-sum');
  assert.equal(await fs.readFile(path.join(config.savePath, 'two-sum.py'), 'utf8'), 'newest editor code');
  assert.equal(context.workspaceState.get('state.v1').cases['two-sum'][0].input, '[3,3]\n6');
  await controller.updateCases('two-sum', [{ input: '[1,2]\n3' }]);
  assert.equal(await fs.readFile(path.join(legacy, 'testcases.json'), 'utf8'), oldCases);
});

test('minimize hides results and restore focuses the retained results view', async t => {
  const { controller, calls } = await fixture(t);
  await controller.minimize();
  assert.ok(calls.some(call => call[0] === 'workbench.action.closePanel'));
  assert.ok(calls.some(call => call[0] === 'setContext' && call[1] === 'singularityLeetcode.resultsVisible' && call[2] === false));
  await controller.showResults();
  assert.ok(calls.some(call => call[0] === 'singularityLeetcode.results.focus'));
});

test('one toggle opens hidden results, closes visible results, and reopens after a native close', async t => {
  const { controller, api, calls } = await fixture(t);
  const view = { visible: false, webview: { postMessage: async () => {} } }; controller.views.set('results', view);
  api.commands.executeCommand = async (...args) => {
    calls.push(args);
    if (args[0] === 'singularityLeetcode.results.focus') view.visible = true;
    if (args[0] === 'workbench.action.closePanel') view.visible = false;
  };
  await controller.toggleResults(); assert.equal(view.visible, true);
  assert.equal(calls.filter(([name]) => name === 'workbench.action.closePanel').length, 0);
  await controller.toggleResults(); assert.equal(view.visible, false);
  await controller.message({ type: 'toggleResults' }); assert.equal(view.visible, true);
  view.visible = false;
  await controller.message({ type: 'minimize' }); assert.equal(view.visible, true);
  await Promise.all([controller.toggleResults(), controller.toggleResults()]); assert.equal(view.visible, true);
});

test('the default-language setting is a dropdown covering every supported file type', () => {
  const { LANGUAGES, EXTENSIONS } = require('../src/languages.cjs');
  const manifest = require('../package.json');
  const setting = manifest.contributes.configuration.properties['singularityLeetcode.defaultLanguage'];
  assert.deepEqual(setting.enum, LANGUAGES.map(([slug]) => slug));
  assert.deepEqual(setting.enumItemLabels, LANGUAGES.map(([_slug, label]) => label));
  assert.ok(setting.enum.includes('pythondata') && setting.enum.includes('react') && setting.enum.includes('vanillajs'));
  assert.ok(setting.enum.every(slug => EXTENSIONS[slug]));
  assert.ok(manifest.activationEvents.includes('onStartupFinished'));
  assert.equal(manifest.contributes.menus['view/title'].length, 1);
  assert.equal(manifest.contributes.menus['view/title'][0].command, 'singularityLeetcode.toggleResults');
  const nativeActions = manifest.contributes.menus['editor/title'];
  assert.deepEqual(nativeActions.map(item => item.command), ['selectLanguage','run','submit','toggleResults'].map(command => 'singularityLeetcode.' + command));
  assert.ok(nativeActions.every(item => item.when.includes('activeWebviewPanelId == singularityLeetcode.description')));
});

test('history loads website submissions, excludes test runs, and opens server code without exposing it to webviews', async t => {
  const { controller, problem, api, calls } = await fixture(t);
  await controller.openProblem('two-sum');
  controller.connection = { status: 'connected', username: 'fixture-account' };
  const options = { problem, owner: 'fixture-account', language: 'python3', code: 'local submitted code', cases: [], fileUri: 'file:///tmp/two-sum.py' };
  const local = await controller.journal.create({ ...options, kind: 'submit' });
  await controller.journal.update(local.id, { status: 'complete', remoteId: '42', result: { accepted: true, verdict: 'Accepted' } });
  const run = await controller.journal.create({ ...options, kind: 'run' });
  await controller.journal.update(run.id, { status: 'complete', remoteId: 'runcode_1.2', result: { verdict: 'All tests passed' } });
  controller.displayed = run.id;
  let pages = 0;
  const remote = id => ({ id, titleSlug: 'two-sum', title: 'Two Sum', lang: 'python3', status: 10, statusDisplay: 'Accepted', timestamp: '1793057511', runtime: '3 ms', memory: '19.2 MB' });
  controller.client.submissions = async (slug, page) => { assert.equal(slug, 'two-sum'); pages++; assert.equal(page.offset, pages === 1 ? 0 : 2); return { submissions: pages === 1 ? [remote('42'), remote('43')] : [remote('44')], lastKey: 'cursor', hasNext: pages === 1 }; };
  await controller.loadHistory();
  assert.equal(controller.state().history.length, 2); assert.ok(controller.state().history.every(item => item.kind === 'submit'));
  assert.ok(controller.state().history.some(item => item.id === local.id));
  assert.equal(controller.state().record.kind, 'run', 'Filtering History must not remove the latest test result');
  await controller.loadHistory(true); assert.equal(controller.state().history.length, 3);
  controller.client.submissionDetails = async id => { assert.equal(id, '43'); return { code: 'exact website submission', statusCode: 10, runtime: 3, memory: 19200000, runtimeDisplay: '3 ms', memoryDisplay: '19.2 MB', runtimePercentile: 0, memoryPercentile: 100, runtimeDistribution: '{"distribution":[[3,100]]}', memoryDistribution: '{"distribution":[[19200,100]]}', lang: { name: 'python3' }, question: { titleSlug: 'two-sum' }, user: { username: 'fixture-account' } }; };
  let opened;
  api.workspace.openTextDocument = async value => { opened = value; return {}; };
  await controller.message({ type: 'snapshot', id: 'submission:43' });
  assert.equal(opened.content, 'exact website submission'); assert.equal(opened.language, 'python');
  assert.equal(calls.filter(([name])=>name==='editor').at(-1)[1].viewColumn,2);
  assert.ok(!JSON.stringify(controller.state()).includes('exact website submission'));
  await controller.message({ type: 'selectAttempt', id: 'submission:43' });
  assert.equal(controller.state().record.result.runtimePercentile, 0);
  assert.equal(controller.state().record.result.memoryPercentile, 100);
  controller.connection = { status: 'connected', username: 'different-account' };
  assert.equal(controller.state().history.length, 0);
  await assert.rejects(controller.message({ type: 'snapshot', id: 'submission:43' }));
});

test('accepted history performance stays inline, uses that submission, and never exposes source or stale-account replies', async t => {
  const { controller, problem } = await fixture(t);
  await controller.openProblem('two-sum'); controller.connection = { status: 'connected', username: 'fixture-account' };
  controller.client.submissions = async () => ({ submissions: ['42','43'].map(id => ({id, titleSlug:'two-sum', timestamp:'1793057511', status:id==='42'?10:11})), hasNext:false });
  await controller.loadHistory();
  const latest = await controller.journal.create({ kind:'run', problem, owner:'fixture-account', language:'python3', code:'latest local code', cases:[], fileUri:'file:///tmp/two-sum.py' });
  controller.displayed = latest.id;
  const messages = [];
  controller.views.set('results', {webview:{postMessage:async message => messages.push(message)}});
  let calls = 0;
  const details = { code:'# private historical code', statusCode:10, runtime:8, runtimeDisplay:'8 ms', runtimePercentile:0, runtimeDistribution:'{"distribution":[[8,100]]}', memory:19900000, memoryDisplay:'19.9 MB', memoryPercentile:75, memoryDistribution:'{"distribution":[[19900,100]]}', user:{username:'fixture-account'}, question:{titleSlug:'two-sum'} };
  controller.client.submissionDetails = async id => { calls++; assert.equal(id,'42'); return details; };
  await controller.message({type:'submissionPerformance',id:'submission:42',request:7});
  const response = messages.find(message => message.type==='submissionPerformance' && message.request===7);
  assert.equal(response.result.runtime,'8 ms'); assert.equal(response.result.runtimePercentile,0);
  assert.equal(response.result.memory,'19.9 MB'); assert.equal(response.result.runtimeDistribution[0][0],8);
  assert.equal(controller.displayed,latest.id);
  assert.equal(controller.state().record.id,latest.id);
  assert.ok(!JSON.stringify(messages).includes('# private historical code'));
  await controller.message({type:'submissionPerformance',id:'submission:43',request:8});
  assert.match(messages.find(message=>message.request===8).error,/accepted submission/);
  assert.equal(calls,1);
  controller.submissions.records.find(record=>record.remoteId==='42').detailsLoaded=false;
  let release;
  controller.client.submissionDetails=()=>new Promise(resolve=>{release=resolve;});
  const loading=controller.message({type:'submissionPerformance',id:'submission:42',request:9});
  controller.authVersion++; controller.connection={status:'connected',username:'another-account'};
  release(details); await loading;
  assert.ok(!messages.some(message=>message.type==='submissionPerformance'&&message.request===9));
});

test('stale server history and code responses cannot cross problem or account changes', async t => {
  const { controller } = await fixture(t);
  await controller.openProblem('two-sum'); controller.connection = { status: 'connected', username: 'fixture-account' };
  let release;
  controller.client.submissions = () => new Promise(resolve => { release = resolve; });
  const loading = controller.loadHistory();
  controller.saved.selected = 'other-problem';
  release({ submissions: [], hasNext: false }); await loading;
  controller.saved.selected = 'two-sum'; assert.equal(controller.submissions.loading, false);
  controller.client.submissions = async () => ({ submissions: [{ id: '42', titleSlug: 'two-sum', timestamp: '1793057511', status: 10 }], hasNext: false });
  await controller.loadHistory(); assert.equal(controller.state().history.length, 1);
  controller.client.submissionDetails = () => new Promise(resolve => { release = resolve; });
  const selection = controller.message({ type: 'selectAttempt', id: 'submission:42' });
  controller.authVersion++; controller.connection = { status: 'connected', username: 'different-account' };
  release({ code: 'must remain private', user: { username: 'fixture-account' }, question: { titleSlug: 'two-sum' }, statusCode: 10 });
  await assert.rejects(selection, /account changed/);
  assert.ok(!JSON.stringify(controller.state()).includes('must remain private'));
});

test('final server history resolves a stale local waiting submission without losing code or resubmitting', async t => {
  const { controller, problem } = await fixture(t);
  await controller.openProblem('two-sum'); controller.connection = { status: 'connected', username: 'fixture-account' };
  const local = await controller.journal.create({ kind: 'submit', problem, owner: 'fixture-account', language: 'python3', code: 'preserved submitted source', cases: [], fileUri: 'file:///tmp/two-sum.py' });
  await controller.journal.update(local.id, { status: 'pending', remoteId: '42', error: 'Poll interrupted' });
  controller.displayed = local.id;
  controller.client.start = async () => { throw new Error('History must never submit code'); };
  controller.client.submissions = async () => ({ submissions: [{ id: '42', titleSlug: 'two-sum', title: 'Two Sum', timestamp: '1793057511', status: 10, statusDisplay: 'Accepted', isPending: 'Not Pending' }], hasNext: false });
  await controller.loadHistory();
  const record = controller.journal.get(local.id);
  assert.equal(record.status, 'complete'); assert.equal(record.result.verdict, 'Accepted');
  assert.equal(record.code, 'preserved submitted source'); assert.equal(record.error, null);
  assert.equal(controller.state().history.length, 1);
  assert.equal(controller.state().history[0].result.verdict, 'Accepted');
  assert.equal(controller.state().record.result.accepted, true);
  controller.client.submissions = async () => ({ submissions: [{ id: '42', titleSlug: 'two-sum', timestamp: '1793057511', status: 11, statusDisplay: 'Wrong Answer', isPending: 'Not Pending' }], hasNext: false });
  await controller.loadHistory();
  assert.equal(controller.state().record.result.verdict, 'Wrong Answer');
  assert.equal(controller.journal.get(local.id).code, 'preserved submitted source');
});

test('ambiguous historical rows get final detail verdicts, with genuine judging and unavailable states kept separate', async t => {
  const { controller } = await fixture(t);
  await controller.openProblem('two-sum'); controller.connection = { status: 'connected', username: 'fixture-account' };
  controller.client.submissions = async () => ({ submissions: Array.from({ length: 5 }, (_, index) => ({ id: String(index + 41), titleSlug: 'two-sum', timestamp: '1793057511', status: 0, statusDisplay: 'Pending', isPending: 'Pending' })), hasNext: false });
  controller.client.submissionStatus = async id => {
    if (id === '45') throw new Error('Unavailable');
    return { statusCode: { 41: 10, 42: 11, 43: 14, 44: 0 }[id], user: { username: 'fixture-account' }, question: { titleSlug: 'two-sum' } };
  };
  await controller.loadHistory();
  const records = controller.state().history;
  assert.deepEqual(records.slice(0, 3).map(record => record.result.verdict), ['Accepted', 'Wrong Answer', 'Time Limit Exceeded']);
  assert.equal(records[3].verdictState, 'judging'); assert.equal(records[4].verdictState, 'unavailable');
  assert.ok(records.every(record => record.kind === 'submit'));
});

test('legacy cached descriptions are refreshed to include company tags and hints', async t => {
  const { controller, problem } = await fixture(t); let fetches = 0;
  controller.saved.problems['two-sum'] = { ...problem, detailsVersion: undefined, hints: undefined };
  controller.client.problem = async () => { fetches++; return problem; };
  await controller.openProblem('two-sum'); await controller.openProblem('two-sum');
  assert.equal(fetches, 1); assert.equal(controller.problem().hints[0], 'Use a hash map.');
});

test('a saved session restores without prompting, and transient failures retain it', async t => {
  const { controller, context, Controller } = await fixture(t);
  const credentials = { session: 'persisted-session', csrf: 'persisted-csrf' };
  await context.secrets.store('leetcode.session.v1', JSON.stringify(credentials));
  const restored = new Controller(context, controller.journal); t.after(() => restored.dispose());
  let accounts = 0;
  restored.client.account = async () => { accounts++; assert.deepEqual(await restored.client.credentials(), credentials); return { username: 'fixture-account' }; };
  restored.search = async () => {};
  await restored.restore(); assert.equal(restored.connection.status, 'connected'); assert.equal(accounts, 1);
  assert.equal(restored.state().busy, false);
  restored.dispose(); assert.ok(await context.secrets.get('leetcode.session.v1'));
  restored.client.account = async () => { const error = new Error('Temporarily offline'); error.code = 'network'; throw error; };
  await restored.restore(); assert.equal(restored.connection.status, 'network');
  assert.ok(await context.secrets.get('leetcode.session.v1'));
});

test('VS Code opens the Orbit statement on the left and the native solution on the right', async t => {
  const { controller, calls, api } = await fixture(t);
  api.env.appName = 'Visual Studio Code';
  await controller.openProblem('two-sum');
  const editorIndex = calls.findIndex(([name]) => name === 'editor');
  const panelIndex = calls.findIndex(([name]) => name === 'panel');
  assert.ok(panelIndex >= 0 && editorIndex > panelIndex, 'The statement creates the first group before the source requests a second group');
  assert.equal(calls[panelIndex][1].viewColumn, 1);
  assert.equal(calls[editorIndex][1].viewColumn, 2);
  assert.equal(calls[panelIndex][1].preserveFocus, true);
});

test('Singularity reuses the description without reattaching its first column', async t => {
  const { controller, calls } = await fixture(t);
  await controller.openProblem('two-sum');
  assert.equal(calls.filter(([name]) => name === 'reveal').length, 0);
  await controller.openProblem('two-sum');
  assert.deepEqual(calls.find(([name]) => name === 'reveal'), ['reveal', undefined, true]);
});

test('problem filters persist across server pagination and stale searches cannot replace them', async t => {
  const { controller } = await fixture(t);
  const requests = [];
  let release;
  controller.client.list = async options => {
    requests.push(options);
    if (options.search === 'stale') return new Promise(resolve => { release = resolve; });
    return { questions: [{ titleSlug: 'two-sum' }], total: 30 };
  };
  const filters = { difficulty: 'Medium', tag: { name: 'Array', slug: 'array' } };
  const stale = controller.search('stale');
  await controller.message({ type: 'search', search: 'sum', filters });
  await controller.message({ type: 'more' });
  release({ questions: [], total: 0 }); await stale;
  assert.equal(controller.state().browser.questions.length, 2);
  assert.equal(controller.state().browser.search, 'sum');
  assert.equal(controller.state().browser.filters.tag.slug, 'array');
  assert.equal(requests[2].skip, 1); assert.equal(requests[2].difficulty, 'Medium'); assert.equal(requests[2].tag, 'array');
  await controller.message({ type: 'search', search: '', filters: { difficulty: '', tag: null } });
  assert.equal(controller.state().browser.questions.length, 1);
  await assert.rejects(controller.message({ type: 'search', search: '', filters: { difficulty: 'Invalid' } }));
});

test('favorites survive restart and contain only opened problem identifiers', async t => {
  const { controller, context, Controller } = await fixture(t);
  await assert.rejects(controller.message({ type: 'toggleFavorite', slug: 'not-opened' }));
  await controller.openProblem('two-sum');
  await controller.message({ type: 'toggleFavorite', slug: 'two-sum' });
  assert.deepEqual(context.workspaceState.get('state.v1').favorites, ['two-sum']);
  const restored = new Controller(context, controller.journal); t.after(() => restored.dispose());
  assert.equal(restored.state().favorites[0], 'two-sum');
  assert.equal(restored.state().knownProblems[0].titleSlug, 'two-sum');
  assert.ok(!JSON.stringify(restored.state().knownProblems).includes('class Solution'));
  await restored.message({ type: 'toggleFavorite', slug: 'two-sum' });
  assert.equal(context.workspaceState.get('state.v1').favorites.length, 0);
});

test('native language selection preserves the previous solution and rejects a stale problem choice', async t => {
  const { controller, problem, api, config } = await fixture(t);
  problem.codeSnippets.push({ lang: 'C++', langSlug: 'cpp', code: '// C++ starter' });
  await controller.openProblem('two-sum');
  await fs.writeFile(path.join(config.savePath, 'two-sum.py'), '# preserved Python work');
  api.window.showQuickPick = async choices => choices.find(choice => choice.slug === 'cpp');
  await controller.selectLanguage();
  assert.equal(controller.state().language, 'cpp');
  assert.equal(await fs.readFile(path.join(config.savePath, 'two-sum.py'), 'utf8'), '# preserved Python work');
  assert.equal(await fs.readFile(path.join(config.savePath, 'two-sum.cpp'), 'utf8'), '// C++ starter\n');
  let resolve;
  api.window.showQuickPick = () => new Promise(done => { resolve = done; });
  const selecting = controller.selectLanguage();
  controller.saved.selected = 'other-problem'; resolve({ slug: 'python3' });
  await assert.rejects(selecting, /problem changed/);
});

test('moving focus to a panel retains native solution actions; an unrelated editor clears them', async t => {
  const { controller, calls, api } = await fixture(t);
  await controller.openProblem('two-sum');
  await controller.editorChanged(undefined);
  let contexts = calls.filter(call => call[0] === 'setContext' && call[1] === 'singularityLeetcode.solutionActive');
  assert.equal(contexts.at(-1)[2], true);
  await controller.editorChanged({ document: { uri: api.Uri.file('/tmp/unrelated.py') } });
  contexts = calls.filter(call => call[0] === 'setContext' && call[1] === 'singularityLeetcode.solutionActive');
  assert.equal(contexts.at(-1)[2], false);
});

test('switching selected problems during save cannot submit code to the wrong problem', async t => {
  const { controller, api, problem } = await fixture(t);
  await controller.openProblem('two-sum');
  controller.connection = { status: 'connected', username: 'fixture-account' };
  let release;
  api.workspace.openTextDocument = async () => ({ getText: () => 'exact solution', save: () => new Promise(resolve => { release = resolve; }) });
  const attempts = [];
  controller.judge.execute = async attempt => attempts.push(attempt);
  const sending = controller.execute('submit');
  await assert.rejects(controller.execute('submit'), /already active/);
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  controller.saved.problems['other-problem'] = { ...problem, titleSlug: 'other-problem', questionId: '99' };
  controller.saved.selected = 'other-problem';
  release(true); await sending;
  assert.equal(attempts.length, 1); assert.equal(attempts[0].problem.titleSlug, 'two-sum');
  assert.equal(attempts[0].code, 'exact solution'); assert.equal(controller.state().busy, false);
});

test('file picker stores the chosen save folder in extension settings', async t => {
  const { controller, config } = await fixture(t);
  const expected = config.savePath;
  await controller.chooseSavePath();
  assert.equal(config.savePath, expected);
});

test('a stale account refresh cannot undo a later sign-out', async t => {
  const { controller } = await fixture(t); let release;
  controller.client.account = () => new Promise(resolve => { release = resolve; });
  controller.client.disconnect = async () => {};
  const refreshing = controller.refresh(false);
  await controller.exit();
  release({ username: 'old-account' }); await refreshing;
  assert.equal(controller.connection.status, 'disconnected');
  assert.equal(controller.connection.username, null);
});

test('code cannot be submitted while account setup is in progress', async t => {
  const { controller } = await fixture(t);
  controller.connecting = true;
  await assert.rejects(controller.execute('submit'), /connection setup/);
  assert.equal(controller.journal.list().length, 0);
});

test('browser sign-in validates its callback account before saving credentials and publishing connection', async t => {
  const { controller, api, context } = await fixture(t);
  api.env.appName = 'Visual Studio Code'; api.env.uriScheme = 'vscode-insiders';
  api.window.showQuickPick = async choices => choices[0];
  let searched = false;
  controller.search = async () => { searched = true; };
  controller.client.fetch = async (_url, request) => {
    assert.equal(await context.secrets.get('leetcode.session.v1'), undefined);
    assert.equal(request.headers.Cookie, 'LEETCODE_SESSION=dummy-session; csrftoken=dummy-csrf');
    return { ok: true, text: async () => JSON.stringify({ data: { userStatus: { isSignedIn: true, username: 'fixture-account' } } }) };
  };
  controller.openSignInUrl = async url => {
    const authorization = new URL(url);
    assert.equal(authorization.pathname, '/authorize-login/vscode-insiders/');
    assert.equal(controller.state().authorizing, true);
    const target = `vscode-insiders://${authorization.searchParams.get('path')}?${new URLSearchParams({ cookie: 'LEETCODE_SESSION=dummy-session; csrftoken=dummy-csrf' })}`;
    assert.equal(controller.browserAuth.handleUri(api.Uri.parse(target)), true);
    return true;
  };
  await controller.connect();
  assert.equal(controller.connection.username, 'fixture-account'); assert.equal(searched, true);
  assert.equal(controller.state().authorizing, false); assert.equal(controller.state().busy, false);
  assert.ok(await context.secrets.get('leetcode.session.v1'));
  assert.ok(!JSON.stringify(controller.state()).includes('dummy-session'));
});

test('Exit cancels a browser sign-in and rejects a late callback', async t => {
  const { controller, api } = await fixture(t);
  api.env.appName = 'Visual Studio Code'; api.env.uriScheme = 'vscode';
  api.window.showQuickPick = async choices => choices[0];
  let authorization;
  controller.openSignInUrl = async url => { authorization = new URL(url); return true; };
  const connecting = controller.connect();
  while (!authorization) await new Promise(resolve => setTimeout(resolve, 1));
  await controller.exit(); await connecting;
  const target = `vscode://${authorization.searchParams.get('path')}?${new URLSearchParams({ cookie: 'LEETCODE_SESSION=late; csrftoken=late' })}`;
  assert.equal(controller.browserAuth.handleUri(api.Uri.parse(target)), false);
  assert.equal(controller.state().connection.status, 'disconnected'); assert.equal(controller.state().busy, false);
});

test('an unavailable browser clears the pending sign-in instead of leaving Connect disabled', async t => {
  const { controller, api } = await fixture(t);
  api.env.appName = 'Visual Studio Code'; api.window.showQuickPick = async choices => choices[0];
  controller.openSignInUrl = async () => false;
  await assert.rejects(controller.connect(), /browser could not be opened/);
  assert.equal(controller.state().authorizing, false); assert.equal(controller.state().busy, false);
});

test('webviews use a nonce CSP and never receive session cookies', async t => {
  const { controller, html, context, api } = await fixture(t);
  const document = html({ asWebviewUri: value => value.toString(), cspSource: 'vscode-resource:' }, context, 'results');
  assert.match(document, /default-src 'none'/); assert.match(document, /script-src 'nonce-/);
  assert.ok(!document.includes('unsafe-inline'));
  controller.connection = { status: 'connected', username: 'fixture-account' };
  assert.ok(!JSON.stringify(controller.state()).includes('LEETCODE_SESSION'));
  await assert.rejects(controller.message({ type: 'openExternal', url: 'https://evil.example/collect' }), /Only LeetCode links/);
  await controller.message({ type: 'openExternal', url: 'https://leetcode.com/problems/two-sum/' });
  assert.equal(api.env.appName, 'Singularity');
});
