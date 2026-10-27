'use strict';
const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const sync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const fixture = require('../test/ui-fixture.cjs');

(async () => {
  const root = path.join(__dirname, '..');
  const output = path.join(root, 'test-artifacts'); await fs.mkdir(output, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-ui-'));
  const chrome = process.env.CHROME_PATH || (sync.existsSync('/opt/google/chrome/chrome') ? '/opt/google/chrome/chrome' : undefined);
  const browser = await chromium.launch({ executablePath: chrome, headless: true, args: process.env.CI ? ['--no-sandbox'] : [] });
  const page = await browser.newPage({ viewport: { width: 900, height: 600 }, colorScheme: 'dark' });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.messages = []; let remembered; window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message), getState: () => remembered, setState: value => { remembered = value; } }); });
  const emit = state => page.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state } })), state);
  async function open(mode) {
    const wrapper = path.join(temporary, `${mode}.html`);
    await fs.writeFile(wrapper, `<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(root, 'media/main.css')).href}"></head><body data-mode="${mode}"><main id="app"></main><script src="${pathToFileURL(path.join(root, 'media/main.js')).href}"></script></body></html>`);
    await page.goto(pathToFileURL(wrapper).href); await page.waitForFunction(() => window.messages.some(message => message.type === 'ready'));
  }
  try {
    let state = fixture(); delete state.accepted;
    await open('problems'); await page.setViewportSize({ width: 320, height: 900 }); await emit(state);
    assert.equal(await page.locator('.side-controls button').count(), 3);
    assert.equal(await page.getByText('LeetCode Workspace', { exact: true }).count(), 0);
    await page.locator('[data-action="toggleResults"]').click();
    assert.ok(await page.evaluate(() => window.messages.some(m => m.type === 'toggleResults')));
    await page.locator('[data-action="chooseSavePath"]').click();
    assert.ok(await page.evaluate(() => window.messages.some(m => m.type === 'chooseSavePath')));
    await page.screenshot({ path: path.join(output, 'sidebar.png'), fullPage: true });
    await page.locator('[data-slug="two-sum"]').click();
    assert.ok(await page.evaluate(() => window.messages.some(m => m.type === 'openProblem' && m.slug === 'two-sum')));
    await page.locator('[data-action="run"]').click();
    assert.ok(await page.evaluate(() => window.messages.some(m => m.type === 'run' && !('cases' in m))), 'Sidebar Run must use the newest host cases instead of an old sidebar copy');
    await page.locator('#search').blur();
    await emit({ ...state, busy: true, connectionBusy: true, authorizing: true });
    assert.match(await page.locator('[role="status"]').first().innerText(), /Complete authorization/);
    assert.equal(await page.locator('[data-action="exit"]').isEnabled(), true);
    assert.equal(await page.locator('[data-action="connect"]').isEnabled(), false);

    await open('results'); await page.setViewportSize({ width: 900, height: 600 }); await emit(state);
    assert.equal(await page.locator('textarea').count(), 1);
    assert.equal(await page.locator('[data-field="expected"]').count(), 0);
    assert.ok(!/Expected output/i.test(await page.locator('#output').innerText()));
    await page.locator('[data-field="input"]').fill('[3,3]\n6');
    assert.ok(await page.evaluate(() => window.messages.some(m => m.type === 'saveCases' && m.cases[0].input === '[3,3]\n6')));
    await page.locator('[data-action="run"]').click();
    assert.ok(await page.evaluate(() => window.messages.some(m => m.type === 'run' && m.cases[0].input === '[3,3]\n6')));
    const failed = fixture();
    failed.record = { ...failed.accepted, id: 'run-1', kind: 'run', result: { verdict: 'Wrong Answer', passed: false, cases: [{ input: '[3,3]\n6', actual: '[0,0]', expected: 'must-not-be-shown', passed: false }], stdout: [] } };
    await emit(failed);
    assert.equal(await page.locator('.io label').count(), 2);
    assert.ok(!/Expected|must-not-be-shown/.test(await page.locator('#output').innerText()));
    failed.record = { ...failed.record, id: 'submission-failed', kind: 'submit', result: { ...failed.record.result, failingInput: '[3,3]\n6', actual: '[0,0]', expected: 'must-not-be-shown', cases: [] } };
    await emit(failed);
    assert.equal(await page.locator('.io label').count(), 2);
    assert.ok(!/Expected|must-not-be-shown/.test(await page.locator('#output').innerText()));
    state = fixture(); state.record = state.accepted; delete state.accepted; await emit(state);
    await page.getByRole('heading', { name: 'Accepted', exact: true }).waitFor();
    assert.match(await page.locator('#output').innerText(), /63 \/ 63 passed/);
    await page.screenshot({ path: path.join(output, 'accepted.png'), fullPage: true });
    assert.equal(await page.locator('[data-action="minimize"],[data-action="toggleResults"]').count(), 0);
    const acceptedText = await page.locator('#output').innerText();
    assert.ok(!/snapshot|a87fe094b1a5|1042839576|View submitted code/.test(acceptedText));
    assert.equal(await page.locator('.metric').count(), 2);
    assert.match(await page.locator('.metric').nth(0).innerText(), /3 ms\s+Beats 91.80%/);
    assert.match(await page.locator('.metric').nth(1).innerText(), /19.2 MB\s+Beats 82.40%/);
    assert.equal(await page.locator('svg.distribution-chart').count(), 2);
    assert.equal(await page.locator('.chart-marker').count(), 2);
    for (const width of [320, 600, 1024]) {
      await page.setViewportSize({ width, height: 700 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Charts overflow at ${width}`);
    }
    await emit({ ...state, record: { ...state.record, result: { ...state.record.result, runtimePercentile: 0, memoryPercentile: 100 } } });
    await page.getByText('Beats 0.00%', { exact: true }).waitFor();
    await page.getByText('Beats 100.00%', { exact: true }).waitFor();
    await emit({ ...state, record: { ...state.record, result: { ...state.record.result, runtimePercentile: null, memoryPercentile: '', runtimeDistribution: [], memoryDistribution: [] } } });
    assert.equal(await page.getByText('Beats unavailable', { exact: true }).count(), 2);
    assert.equal(await page.locator('svg.distribution-chart').count(), 0);
    await emit(state);
    await page.setViewportSize({ width: 900, height: 600 });
    await page.screenshot({ path: path.join(output, 'accepted.png'), fullPage: true });
    await page.locator('[data-tab="history"]').click();
    assert.ok(await page.evaluate(() => window.messages.some(m => m.type === 'loadHistory')));
    const runEntry = { ...state.record, id: 'excluded-test-run', kind: 'run', result: { verdict: 'All tests passed' } };
    await emit({ ...state, history: [runEntry, ...state.history], submissionHistory: { hasNext: true } });
    assert.equal(await page.locator('.history tbody tr').count(), 1);
    assert.equal(await page.getByText('All tests passed', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('columnheader', { name: 'Type', exact: true }).count(), 0);
    await page.locator('[data-action="moreHistory"]').click();
    assert.ok(await page.evaluate(() => window.messages.some(m => m.type === 'moreHistory')));
    await page.locator('[data-action="snapshot"]').click();
    assert.ok(await page.evaluate(() => window.messages.some(m => m.type === 'snapshot' && m.id === 'attempt-1')));
    await page.locator('[data-action="selectAttempt"]').click();
    assert.ok(await page.evaluate(() => window.messages.some(m => m.type === 'selectAttempt' && m.id === 'attempt-1')));
    await emit(state);
    state.record = { ...state.record, id: 'attempt-2', status: 'uncertain', result: undefined, remoteId: undefined, error: 'Response lost.' }; state.error = state.record.error; await emit(state);
    await page.getByRole('heading', { name: 'Delivery unconfirmed' }).waitFor();
    assert.match(await page.locator('#output').innerText(), /Check LeetCode history/);
    assert.equal(await page.getByText('Response lost.', { exact: true }).count(), 1);
    for (const width of [320, 600, 1024]) {
      await page.setViewportSize({ width, height: 700 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Result panel overflows at ${width}`);
    }
    await page.screenshot({ path: path.join(output, 'recovery.png'), fullPage: true });

    await open('description'); state = fixture();
    state.problem.content += '<script>window.injected=true</script><img src="https://evil.example/pixel" onerror="window.injected=true"><a href="javascript:window.injected=true">bad link</a><iframe src="https://evil.example"></iframe><a href="https://leetcode.com/problems/two-sum/">official</a>';
    state.problem.hints.push('<script>window.injected=true</script><a href="javascript:bad()">bad hint</a><img src="https://evil.example/image" onerror="window.injected=true">');
    await emit(state); assert.equal(await page.locator('#statement script,#statement iframe,[onerror],.hints script,.hints [onerror]').count(), 0);
    assert.equal(await page.locator('#statement a[href^="javascript:"]').count(), 0);
    assert.equal(await page.locator('#statement img[src^="https://evil"]').count(), 0);
    assert.equal(await page.evaluate(() => Boolean(window.injected)), false);
    assert.equal(await page.locator('.companies').getAttribute('open'), null);
    await page.locator('.companies summary').click();
    await page.getByText('Example Labs', { exact: true }).waitFor();
    assert.equal(await page.locator('.hints details[open]').count(), 0);
    await page.locator('.hints summary').first().click();
    await page.locator('.hint-body code').getByText('hash map').waitFor();
    assert.equal(await page.locator('.hints a[href^="javascript:"],.hints img[src^="https://evil"]').count(), 0);
    for (const difficulty of ['Easy', 'Medium', 'Hard']) {
      state.problem.difficulty = difficulty; await emit(state);
      assert.equal(await page.locator('.tags .difficulty-' + difficulty.toLowerCase()).count(), 1);
    }
    state.problem.companies = []; state.problem.companiesAvailable = false; await emit(state);
    await page.locator('.companies summary').click();
    await page.getByText('Company tags are unavailable for this account.', { exact: true }).waitFor();
    await page.getByText('official', { exact: true }).click(); assert.ok(await page.evaluate(() => window.messages.some(m => m.type === 'openExternal')));
    await page.screenshot({ path: path.join(output, 'description.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('Browser checks passed: judge results, runtime/memory beats and distribution charts, submission-only history, pagination, code actions, sidebar/toggle controls, company tags, hints, difficulty badges, uncertain delivery, responsive layout, and sanitization.');
    console.log(`Screenshots: ${output}`);
  } finally { await browser.close(); await fs.rm(temporary, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
