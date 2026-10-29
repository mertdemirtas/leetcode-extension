'use strict';
const { normalizeResult, STATUS } = require('./judge.cjs');

function submissionRecord(item, owner) {
  // A final verdict outranks flags or cached "pending" state. Some list
  // responses omit the status code, so also recognize the displayed verdict.
  const display = typeof item.statusDisplay === 'string' ? item.statusDisplay.trim() : '';
  const namedCode = Object.keys(STATUS).find(code => STATUS[code].toLowerCase() === display.toLowerCase());
  const code = STATUS[Number(item.status)] ? Number(item.status) : namedCode ? Number(namedCode) : null;
  const finalLabel = display && !/^(pending|judging|running|started|queued|queueing|in queue|waiting(?: for a result)?)\b/i.test(display);
  const pending = code === null && !finalLabel;
  return {
    id: `submission:${item.id}`, remoteId: item.id, kind: 'submit', local: false, owner, slug: item.titleSlug, title: item.title,
    language: item.lang, createdAt: new Date(Number(item.timestamp) * 1000).toISOString(),
    status: pending ? 'pending' : 'complete',
    verdictState: pending ? 'fetching' : undefined,
    result: pending ? undefined : normalizeResult({ status_code: code ?? item.status, status_msg: STATUS[code] || display, status_runtime: item.runtime, status_memory: item.memory }, 'submit')
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
    const key = record.remoteId ? `${record.owner}:${record.remoteId}` : record.id;
    const server = records.get(key);
    if (!server) { records.set(key, record); continue; }
    const final = server.status === 'complete' ? server : record.status === 'complete' ? record : server;
    const cached = Boolean(record.detailsLoaded && record.result?.verdict === final.result?.verdict);
    records.set(key, { ...server, ...record, status: final.status, result: cached ? record.result : final.result, verdictState: final.verdictState, detailsLoaded: cached });
  }
  return [...records.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

module.exports = { submissionRecord, submissionResult, mergeSubmissions };
