'use strict';
const { normalizeResult } = require('./judge.cjs');

function submissionRecord(item, owner) {
  // LeetCode returns strings such as "Not Pending", not just booleans.
  const flag = typeof item.isPending === 'string' ? item.isPending.trim().toLowerCase() : item.isPending;
  const finished = Number.isFinite(Number(item.status)) && Number(item.status) >= 10;
  const pending = !finished && [true, 1, 'true', '1', 'pending'].includes(flag);
  return {
    id: `submission:${item.id}`, remoteId: item.id, kind: 'submit', local: false, owner, slug: item.titleSlug, title: item.title,
    language: item.lang, createdAt: new Date(Number(item.timestamp) * 1000).toISOString(),
    status: pending ? 'pending' : 'complete',
    result: pending ? undefined : normalizeResult({ status_code: item.status, status_msg: item.statusDisplay, status_runtime: item.runtime, status_memory: item.memory }, 'submit')
  };
}

function submissionResult(details) {
  return normalizeResult({
    status_code: details.statusCode, status_runtime: details.runtimeDisplay, status_memory: details.memoryDisplay,
    runtime: details.runtime, memory: details.memory, runtime_percentile: details.runtimePercentile, memory_percentile: details.memoryPercentile,
    runtime_distribution: details.runtimeDistribution, memory_distribution: details.memoryDistribution,
    total_correct: details.totalCorrect, total_testcases: details.totalTestcases,
    std_output: details.stdOutput, last_testcase: details.lastTestcase, code_output: details.codeOutput,
    compile_error: details.compileError, runtime_error: details.runtimeError
  }, 'submit');
}

function mergeSubmissions(local, remote) {
  const records = new Map();
  for (const record of [...remote, ...local]) {
    if (record.kind !== 'submit') continue;
    records.set(record.remoteId ? `${record.owner}:${record.remoteId}` : record.id, record);
  }
  return [...records.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

module.exports = { submissionRecord, submissionResult, mergeSubmissions };
