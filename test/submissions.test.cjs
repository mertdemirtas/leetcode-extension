'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { submissionRecord, submissionResult, mergeSubmissions } = require('../src/submissions.cjs');
const { normalizeResult } = require('../src/judge.cjs');

test('submission history excludes runs and deduplicates local submissions against the server list', () => {
  const remote = submissionRecord({ id: '42', titleSlug: 'two-sum', title: 'Two Sum', lang: 'python3', status: 10, statusDisplay: 'Accepted', timestamp: '1793057511', runtime: '3 ms', memory: '19.2 MB' }, 'fixture-account');
  const local = { ...remote, id: 'local-42', local: true, code: 'saved code' };
  const run = { ...local, id: 'run-1', remoteId: 'runcode_1.2', kind: 'run' };
  const other = { ...remote, id: 'submission:43', remoteId: '43', createdAt: '2026-10-27T02:00:00Z' };
  const history = mergeSubmissions([run, local], [remote, other]);
  assert.deepEqual(history.map(record => record.id), ['submission:43', 'local-42']);
  assert.equal(history[1].code, 'saved code');
});

test('server details preserve zero percentiles and normalize actual runtime and memory distributions', () => {
  const result = submissionResult({ statusCode: 10, runtime: 3, runtimeDisplay: '3 ms', memory: 19200000, memoryDisplay: '19.2 MB', runtimePercentile: 0, memoryPercentile: '100', runtimeDistribution: '{"distribution":[["8",20],["3",80]]}', memoryDistribution: '{"distribution":[["19200",60],["20500",40]]}' });
  assert.equal(result.runtimePercentile, 0); assert.equal(result.memoryPercentile, 100);
  assert.equal(result.runtimeValue, 3); assert.equal(result.memoryValue, 19200);
  assert.deepEqual(result.runtimeDistribution, [[3, 80], [8, 20]]);
  assert.deepEqual(result.memoryDistribution, [[19200, 60], [20500, 40]]);
  assert.equal(result.accepted, true);
});

test('missing or malformed comparison data cannot fabricate beats percentages or chart bins', () => {
  for (const value of [null, undefined, '', 'NaN', Infinity, -1, 101, true, {}]) {
    const result = normalizeResult({ status_code: 10, runtime_percentile: value, memory_percentile: value, runtime_distribution: 'invalid', memory_distribution: { distribution: [['bad', 10], [1, -1], [2, 10], [3, 101]] } }, 'submit');
    assert.equal(result.runtimePercentile, null); assert.equal(result.memoryPercentile, null);
    assert.deepEqual(result.runtimeDistribution, []); assert.deepEqual(result.memoryDistribution, [[2, 10]]);
  }
});
