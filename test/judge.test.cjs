'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Journal } = require('../src/journal.cjs');
const { Judge, normalizeResult, exampleCases, validateCases } = require('../src/judge.cjs');
const { ConnectionError, LeetCodeClient } = require('../src/client.cjs');
const problem = { title: 'Two Sum', titleSlug: 'two-sum', questionId: '1' };
const options = () => ({ kind: 'submit', owner: 'fixture-account', problem, language: 'python3', code: 'class Solution:\n    pass\n', cases: [{ name: 'Case 1', input: '[2,7]\n9', expected: '[0,1]' }], fileUri: 'file:///tmp/python3.py' });
async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const journal = new Journal(directory); await journal.load(); return journal;
}

test('a real client retains and polls a dotted run ID until the result is durable', async t => {
  const journal = await setup(t);
  const id = 'runcode_1627219627.5662382_EI7iasnhLm'; let starts = 0, checks = 0;
  const client = new LeetCodeClient({ secrets: { get: async () => JSON.stringify({ session: 'fixture-session', csrf: 'fixture-csrf' }) }, fetchImpl: async (url, request) => {
    let result;
    if (request.method === 'POST') { starts++; result = { interpret_id: id }; }
    else {
      checks++; assert.equal(url, `https://leetcode.com/submissions/detail/${id}/check/`);
      assert.equal(JSON.parse(await fs.readFile(journal.file, 'utf8')).records[0].remoteId, id);
      result = checks === 1 ? { state: 'PENDING' } : { state: 'SUCCESS', status_code: 10, correct_answer: true, compare_result: '1', code_answer: ['[0,1]'] };
    }
    return new Response(JSON.stringify(result));
  } });
  const judge = new Judge({ client, journal, sleep: async () => {} });
  const run = await judge.execute({ ...options(), kind: 'run' });
  assert.equal(run.status, 'complete'); assert.equal(run.result.verdict, 'All tests passed');
  const restored = new Journal(journal.directory); await restored.load();
  assert.equal(restored.get(run.id).remoteId, id); assert.equal(restored.get(run.id).result.cases[0].actual, '[0,1]');
  assert.equal(starts, 1); assert.equal(checks, 2);
});

test('source is durable before sending and exact results survive restart', async t => {
  const journal = await setup(t); let posts = 0, checks = 0;
  const client = {
    async start(_kind, sent) {
      posts++;
      const disk = JSON.parse(await fs.readFile(journal.file, 'utf8')).records[0];
      assert.equal(disk.code, sent.code); assert.equal(disk.status, 'sending');
      return '12345';
    },
    async check() { checks++; return checks === 1 ? { state: 'PENDING' } : { state: 'SUCCESS', status_code: 10, total_correct: 63, total_testcases: 63, status_runtime: '3 ms', status_memory: '19 MB' }; }
  };
  const judge = new Judge({ client, journal, sleep: async () => {} });
  const record = await judge.execute(options());
  assert.equal(record.status, 'complete'); assert.equal(record.result.verdict, 'Accepted');
  assert.equal(record.result.runtime, '3 ms'); assert.equal(posts, 1);
  const restored = new Journal(journal.directory); await restored.load();
  assert.equal(restored.get(record.id).code, options().code);
  assert.equal(restored.get(record.id).remoteId, '12345');
  assert.equal(judge.busy, false);
  if (process.platform !== 'win32') assert.equal((await fs.stat(journal.file)).mode & 0o777, 0o600);
});

test('lost submission response is retained and blocks duplicate posts', async t => {
  const journal = await setup(t); let posts = 0;
  const judge = new Judge({ journal, client: { async start() { posts++; throw new ConnectionError('network', 'Response lost', { uncertain: true }); } } });
  await assert.rejects(judge.execute(options()), /Response lost/);
  assert.equal(journal.list()[0].status, 'uncertain');
  await assert.rejects(judge.execute(options()), /earlier request is unresolved/);
  assert.equal(posts, 1);
});

test('pending result recovery checks the saved ID without resubmitting code', async t => {
  const journal = await setup(t); let posts = 0;
  const judge = new Judge({ journal, maxPolls: 1, sleep: async () => {}, client: { async start() { posts++; return '54321'; }, async check() { return { state: 'PENDING' }; } } });
  const pending = await judge.execute(options()); assert.equal(pending.status, 'pending');
  const restored = new Journal(journal.directory); await restored.load();
  const recovery = new Judge({ journal: restored, client: { async start() { throw Error('Must not resubmit'); }, async check(id) { assert.equal(id, '54321'); return { state: 'SUCCESS', status_code: 11, last_testcase: '[3,3]\n6', code_output: '[0,0]', expected_code_output: '[0,1]' }; } } });
  await assert.rejects(recovery.resume(pending.id, 'someone-else'), /account that created/);
  const complete = await recovery.resume(pending.id, 'fixture-account');
  assert.equal(complete.result.verdict, 'Wrong Answer');
  assert.equal(complete.result.failingInput, '[3,3]\n6'); assert.equal(posts, 1);
});

test('poll errors retain the ID and the original code for later recovery', async t => {
  const journal = await setup(t);
  const judge = new Judge({ journal, client: { async start() { return 'abc'; }, async check() { throw new ConnectionError('rate-limit', 'Wait'); } } });
  await assert.rejects(judge.execute(options()), /Wait/);
  const record = journal.list()[0];
  assert.equal(record.status, 'pending'); assert.equal(record.remoteId, 'abc'); assert.equal(record.code, options().code);
});

test('an unconfirmed test run can be repeated by an explicit click without submitting', async t => {
  const journal = await setup(t); let starts = 0;
  const judge = new Judge({ journal, client: { async start(kind) { assert.equal(kind, 'run'); starts++; if (starts === 1) throw new ConnectionError('network', 'Response lost', { uncertain: true }); return 'run-2'; }, async check() { return { state: 'SUCCESS', status_code: 10, correct_answer: true }; } } });
  await assert.rejects(judge.execute({ ...options(), kind: 'run' }));
  assert.equal(starts, 1);
  await judge.execute({ ...options(), kind: 'run' });
  assert.equal(starts, 2); assert.equal(journal.list()[0].result.verdict, 'All tests passed');
});

test('a crash during delivery becomes uncertain rather than automatically requeued', async t => {
  const journal = await setup(t);
  const record = await journal.create(options()); await journal.update(record.id, { status: 'sending' });
  const restored = new Journal(journal.directory); await restored.load();
  assert.equal(restored.get(record.id).status, 'uncertain');
});

test('corrupt journal files are preserved and prevent new sends', async t => {
  const journal = await setup(t); await fs.writeFile(journal.file, '{broken');
  await assert.rejects(journal.load(), /preserved/);
  assert.equal(await fs.readFile(journal.file, 'utf8'), '{broken');
});

test('concurrent run clicks cannot create multiple judge requests', async t => {
  const journal = await setup(t); let release;
  const judge = new Judge({ journal, client: { start: () => new Promise(resolve => { release = resolve; }), check: async () => ({ state: 'SUCCESS', status_code: 10 }) } });
  const first = judge.execute(options());
  await assert.rejects(judge.execute(options()), /already active/);
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  release('1'); await first;
  assert.equal(journal.list().length, 1);
});

test('example inputs are grouped by argument count without changing their contents', () => {
  const cases = exampleCases({ exampleTestcases: '[2,7]\n9\n[3,3]\n6', metaData: '{"params":[{},{}]}' });
  assert.equal(cases.length, 2); assert.equal(cases[1].input, '[3,3]\n6');
  assert.throws(() => validateCases([{ input: '', expected: '' }]), /Every test case/);
});

test('test success is based on judge comparison; absent oracle does not claim a pass', () => {
  const cases = [{ input: '[3,3]\n6', expected: '[0,1]' }];
  const failed = normalizeResult({ status_code: 10, correct_answer: false, compare_result: '0', code_answer: ['[0,0]'], expected_code_answer: ['[0,1]'] }, 'run', cases);
  assert.equal(failed.verdict, 'Wrong Answer'); assert.equal(failed.cases[0].passed, false);
  const unknown = normalizeResult({ status_code: 10, code_answer: ['[0,0]'] }, 'run', cases);
  assert.equal(unknown.verdict, 'Finished'); assert.equal(unknown.passed, false);
  assert.equal(unknown.cases[0].actual, '[0,0]');
  assert.ok(!('expected' in unknown.cases[0]));
  assert.deepEqual(validateCases([{ input: '[3,3]\n6' }]), [{ input: '[3,3]\n6', name: 'Case 1' }]);
  assert.equal(normalizeResult({ status_code: 20, full_compile_error: 'SyntaxError' }, 'submit').error, 'SyntaxError');
});
