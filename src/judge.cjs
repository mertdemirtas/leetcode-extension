'use strict';

const { ConnectionError } = require('./client.cjs');
const STATUS = { 10: 'Accepted', 11: 'Wrong Answer', 12: 'Memory Limit Exceeded', 13: 'Output Limit Exceeded', 14: 'Time Limit Exceeded', 15: 'Runtime Error', 16: 'Internal Error', 20: 'Compile Error', 21: 'Unknown Error' };
const array = value => value === undefined || value === null ? [] : Array.isArray(value) ? value : [String(value)];
const numeric = value => ['number', 'string'].includes(typeof value) && String(value).trim() && Number.isFinite(Number(value)) ? Number(value) : null;
const percentile = value => { const number = numeric(value); return number !== null && number >= 0 && number <= 100 ? number : null; };

function distribution(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    const bins = Array.isArray(parsed) ? parsed : parsed?.distribution;
    if (!Array.isArray(bins) || bins.length > 5000) return [];
    return bins.filter(bin => Array.isArray(bin) && bin.length === 2 && numeric(bin[0]) !== null && numeric(bin[0]) >= 0 && percentile(bin[1]) !== null)
      .map(bin => [Number(bin[0]), Number(bin[1])]).sort((a, b) => a[0] - b[0]);
  } catch { return []; }
}

function exampleCases(problem) {
  const input = problem.exampleTestcases || problem.sampleTestCase || '';
  let params;
  try { params = JSON.parse(problem.metaData).params?.length; } catch { /* Some design problems do not expose parameter metadata. */ }
  const lines = input.trim().split('\n');
  if (params > 0 && lines.length % params === 0) {
    return Array.from({ length: lines.length / params }, (_, index) => ({ input: lines.slice(index * params, (index + 1) * params).join('\n'), name: `Case ${index + 1}` }));
  }
  return [{ input: problem.sampleTestCase || input, name: 'Case 1' }];
}

function validateCases(cases) {
  if (!Array.isArray(cases) || !cases.length || cases.length > 50) throw new Error('Provide between 1 and 50 test cases.');
  if (cases.some(c => !c || typeof c.input !== 'string' || !c.input.trim())) throw new Error('Every test case needs input. Use one JSON argument per line.');
  if (JSON.stringify(cases).length > 200000) throw new Error('Test case input is too large (maximum 200 KB).');
  return cases.map((c, index) => ({ input: c.input.trim(), name: String(c.name || `Case ${index + 1}`).slice(0, 80) }));
}

function normalizeResult(raw, kind, cases = []) {
  const actual = array(raw.code_answer ?? raw.code_output);
  const comparison = typeof raw.compare_result === 'string' ? [...raw.compare_result].filter(c => c === '0' || c === '1') : [];
  const code = Number(raw.status_code);
  let verdict = raw.status_msg || STATUS[code] || 'Finished';
  if (kind === 'run' && code === 10) {
    verdict = raw.correct_answer === false || comparison.includes('0') ? 'Wrong Answer' : raw.correct_answer === true || comparison.length ? 'All tests passed' : 'Finished';
  }
  return {
    verdict, accepted: kind === 'submit' && code === 10, passed: kind === 'run' ? verdict === 'All tests passed' : code === 10,
    runtime: raw.status_runtime ?? raw.display_runtime ?? (raw.runtime !== undefined ? `${raw.runtime} ms` : null),
    memory: raw.status_memory ?? (raw.memory !== undefined ? `${(Number(raw.memory) / 1024 / 1024).toFixed(1)} MB` : null),
    runtimePercentile: percentile(raw.runtime_percentile), memoryPercentile: percentile(raw.memory_percentile),
    runtimeValue: numeric(raw.runtime), memoryValue: numeric(raw.memory) === null ? null : Number(raw.memory) / 1000,
    runtimeDistribution: distribution(raw.runtime_distribution), memoryDistribution: distribution(raw.memory_distribution),
    totalCorrect: raw.total_correct ?? null, totalCases: raw.total_testcases ?? null,
    error: raw.full_compile_error || raw.compile_error || raw.full_runtime_error || raw.runtime_error || '',
    failingInput: raw.last_testcase || '', stdout: array(raw.std_output),
    cases: cases.map((c, index) => ({
      name: c.name, input: c.input, actual: actual[index] ?? null,
      passed: comparison[index] ? comparison[index] === '1' : null
    })),
    actual: actual.join('\n'), raw
  };
}

class Judge {
  constructor({ client, journal, changed = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), maxPolls = 60 }) {
    Object.assign(this, { client, journal, changed, sleep, maxPolls });
    this.busy = false;
    this.cancelled = false;
  }

  async execute(options) {
    if (this.busy) throw new Error('A judge request is already active. Wait for it to finish.');
    if (options.kind === 'submit' && this.journal.list().some(r => r.owner === options.owner && r.slug === options.problem.titleSlug && ['pending', 'uncertain', 'sending'].includes(r.status) && r.kind === 'submit')) {
      throw new Error('An earlier request is unresolved. Open History and check its status before sending another attempt.');
    }
    const cases = options.kind === 'run' ? validateCases(options.cases) : options.cases;
    this.busy = true;
    this.cancelled = false;
    try {
      let record = await this.journal.create({ ...options, cases });
      record = await this.journal.update(record.id, { status: 'sending' });
      this.changed(record);
      let remoteId;
      try {
        remoteId = await this.client.start(options.kind, { ...options, input: cases.map(c => c.input).join('\n') });
      } catch (error) {
        record = await this.journal.update(record.id, { status: error.uncertain ? 'uncertain' : 'failed', error: error.message });
        this.changed(record);
        throw error;
      }
      record = await this.journal.update(record.id, { remoteId, status: 'pending' });
      this.changed(record);
      return await this.poll(record);
    } finally { this.busy = false; }
  }

  async resume(id, owner) {
    if (this.busy) throw new Error('A judge request is already active.');
    const record = this.journal.get(id);
    if (!record || !record.remoteId) throw new Error('No server request ID is available. Check LeetCode history before resolving this attempt.');
    if (record.owner !== owner) throw new Error('Reconnect the account that created this request before checking its result.');
    if (record.status === 'complete') return record;
    this.busy = true; this.cancelled = false;
    try { return await this.poll(record); }
    finally { this.busy = false; }
  }

  async poll(record) {
    try {
      for (let index = 0; index < this.maxPolls && !this.cancelled; index++) {
        const raw = await this.client.check(record.remoteId);
        if (raw.state === 'SUCCESS' || raw.state === 'FAILURE') {
          const result = normalizeResult(raw, record.kind, record.cases);
          const complete = await this.journal.update(record.id, { status: 'complete', result, finishedAt: new Date().toISOString(), error: null });
          this.changed(complete);
          return complete;
        }
        if (!['STARTED', 'PENDING'].includes(raw.state)) throw new ConnectionError('protocol', 'LeetCode returned an unfamiliar judge state. The request ID has been saved for recovery.');
        await this.sleep(Math.min(1000 + index * 100, 3000));
      }
      const pending = await this.journal.update(record.id, { status: 'pending', error: 'The result is still pending. Use Check status in History to continue; no code will be resent.' });
      this.changed(pending);
      return pending;
    } catch (error) {
      const pending = await this.journal.update(record.id, { status: 'pending', error: error.message });
      this.changed(pending);
      throw error;
    }
  }

  cancel() { this.cancelled = true; }
}

module.exports = { Judge, normalizeResult, exampleCases, validateCases };
