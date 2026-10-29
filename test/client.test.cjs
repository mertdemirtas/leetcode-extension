'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LeetCodeClient, SECRET_KEY, validateSlug, validateRequestId } = require('../src/client.cjs');

function secrets(value) {
  const store = new Map(value ? [[SECRET_KEY, JSON.stringify(value)]] : []);
  return { get: async key => store.get(key), store: async (key, value) => store.set(key, value), delete: async key => store.delete(key), values: store };
}
const credentials = { session: 'private.session-token', csrf: 'csrf-token' };
const response = (json, status = 200, headers = {}) => new Response(JSON.stringify(json), { status, headers });

test('connect validates the account before storing cookies in SecretStorage', async () => {
  const storage = secrets(); let request;
  const client = new LeetCodeClient({ secrets: storage, fetchImpl: async (url, options) => { request = { url, options }; return response({ data: { userStatus: { isSignedIn: true, username: 'fixture-account', isPremium: false } } }); } });
  assert.deepEqual(await client.connect(credentials), { username: 'fixture-account', premium: false });
  assert.equal(request.url, 'https://leetcode.com/graphql/');
  assert.equal(request.options.headers.Cookie, 'LEETCODE_SESSION=private.session-token; csrftoken=csrf-token');
  assert.equal(request.options.headers['X-CSRFToken'], 'csrf-token');
  assert.equal(request.options.redirect, 'error');
  assert.deepEqual(JSON.parse(await storage.get(SECRET_KEY)), credentials);
  await client.disconnect(); assert.equal(await storage.get(SECRET_KEY), undefined);
});

test('failed or cancelled sign-in does not replace working credentials', async () => {
  const storage = secrets(credentials);
  const client = new LeetCodeClient({ secrets: storage, fetchImpl: async () => response({ data: { userStatus: { isSignedIn: false } } }) });
  await assert.rejects(client.connect({ session: 'new', csrf: 'new' }), { code: 'auth' });
  assert.deepEqual(JSON.parse(await storage.get(SECRET_KEY)), credentials);
});

test('cookie header injection and invalid slugs are rejected before sending', async () => {
  let calls = 0;
  const client = new LeetCodeClient({ secrets: secrets(), fetchImpl: async () => { calls++; } });
  await assert.rejects(client.connect({ session: 'abc\r\nX-Evil: true', csrf: 'abc' }), { code: 'credentials' });
  assert.throws(() => validateSlug('../../accounts/login'));
  assert.equal(calls, 0);
});

test('run and submit use distinct endpoints and send the exact source snapshot', async () => {
  const calls = [];
  const client = new LeetCodeClient({ secrets: secrets(credentials), fetchImpl: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return response(url.endsWith('/submit/') ? { submission_id: 12345 } : { interpret_id: 'runcode_1627219627.5662382_EI7iasnhLm' }); } });
  const options = { problem: { titleSlug: 'two-sum', questionId: '1' }, language: 'python3', code: 'return "unchanged source"\n', input: '[2,7]\n9' };
  assert.equal(await client.start('run', options), 'runcode_1627219627.5662382_EI7iasnhLm');
  assert.equal(await client.start('submit', options), '12345');
  assert.equal(calls[0].body.data_input, '[2,7]\n9');
  assert.equal(calls[1].body.typed_code, options.code);
  assert.equal('data_input' in calls[1].body, false);
  assert.match(calls[0].url, /interpret_solution\/$/);
  assert.match(calls[1].url, /submit\/$/);
});

test('a submission with a lost response is uncertain and is never retried', async () => {
  let calls = 0;
  const client = new LeetCodeClient({ secrets: secrets(credentials), fetchImpl: async () => { calls++; throw new TypeError('network down'); } });
  await assert.rejects(client.start('submit', { problem: { titleSlug: 'two-sum', questionId: '1' }, language: 'python3', code: 'pass' }), error => error.code === 'network' && error.uncertain && !error.message.includes(credentials.session));
  assert.equal(calls, 1);
});

test('dotted run IDs are polled unchanged and unsafe path segments never reach the network', async () => {
  const calls = [];
  const client = new LeetCodeClient({ secrets: secrets(credentials), fetchImpl: async url => { calls.push(url); return response({ state: 'PENDING' }); } });
  const id = 'runcode_1627219627.5662382_EI7iasnhLm';
  await client.check(id);
  assert.equal(calls[0], `https://leetcode.com/submissions/detail/${id}/check/`);
  for (const invalid of [undefined, null, {}, [], true, 0, -1, 1.5, NaN, Infinity, '', '.', '..', '../x', 'a/b', 'a%2fb', 'a?x=1', 'a#x', 'a\r\nX: bad', 'x'.repeat(257)]) {
    assert.throws(() => validateRequestId(invalid), /Invalid judge request ID/);
    await assert.rejects(client.check(invalid), /Invalid judge request ID/);
  }
  assert.equal(calls.length, 1);
});

test('missing run IDs suggest a new test run; missing submission IDs require history review', async () => {
  const client = new LeetCodeClient({ secrets: secrets(credentials), fetchImpl: async () => response({}) });
  const options = { problem: { titleSlug: 'two-sum', questionId: '1' }, language: 'python3', code: 'pass', input: '[2,7]\n9' };
  await assert.rejects(client.start('run', options), error => error.uncertain && /new test run manually/.test(error.message) && !/submission history/.test(error.message));
  await assert.rejects(client.start('submit', options), error => error.uncertain && /submission history/.test(error.message));
});

test('rate limiting, blocked access, server failure, and malformed responses are distinct', async () => {
  for (const [status, code, uncertain] of [[401, 'auth', false], [403, 'blocked', false], [429, 'rate-limit', false], [503, 'server', true]]) {
    let calls = 0;
    const client = new LeetCodeClient({ secrets: secrets(credentials), fetchImpl: async () => { calls++; return response({}, status, { 'retry-after': '30' }); } });
    await assert.rejects(client.request('/test', { body: {}, mutation: true }), e => e.code === code && e.uncertain === uncertain);
    assert.equal(calls, 1);
    assert.ok(await client.secrets.get(SECRET_KEY), 'A browser challenge must not destroy credentials');
  }
  const client = new LeetCodeClient({ secrets: secrets(credentials), fetchImpl: async () => new Response('<html>Challenge</html>') });
  await assert.rejects(client.request('/test', { body: {}, mutation: true }), e => e.code === 'protocol' && e.uncertain);
});

test('bounded timeouts abort requests without exposing credentials', async () => {
  const client = new LeetCodeClient({ secrets: secrets(credentials), timeout: 10, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) });
  await assert.rejects(client.check('123'), { code: 'network', uncertain: false });
});

test('paging uses server-side search and does not prefetch the entire catalog', async () => {
  const requests = [];
  const client = new LeetCodeClient({ secrets: secrets(), fetchImpl: async (_url, options) => { requests.push(options); return response({ data: { problemsetQuestionList: { total: 1000, questions: [{ questionFrontendId: '1', title: 'Two Sum', titleSlug: 'two-sum', difficulty: 'Easy' }] } } }); } });
  const page = await client.list({ search: 'sum', skip: 25 });
  assert.equal(page.total, 1000);
  assert.deepEqual(JSON.parse(requests[0].body).variables, { skip: 25, limit: 25, filters: { searchKeywords: 'sum' } });
  assert.equal(requests[0].headers.Cookie, undefined);
});

test('difficulty and topic filters reach LeetCode and invalid filters never send a request', async () => {
  const requests = [];
  const client = new LeetCodeClient({ secrets: secrets(), fetchImpl: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return response({ data: { problemsetQuestionList: { total: 0, questions: [] } } });
  } });
  await client.list({ search: 'sum', difficulty: 'Medium', tag: 'hash-table', skip: 25 });
  assert.deepEqual(requests[0].variables, { skip: 25, limit: 25, filters: { searchKeywords: 'sum', difficulty: 'MEDIUM', tags: ['hash-table'] } });
  assert.match(requests[0].query, /topicTags/);
  await assert.rejects(client.list({ difficulty: 'medium' }));
  await assert.rejects(client.list({ tag: '../invalid' }));
  assert.equal(requests.length, 1);
});

test('problem details include sanitized-shape hints and deduplicated company tags from both server fields', async () => {
  let query;
  const client = new LeetCodeClient({ secrets: secrets(), fetchImpl: async (_url, options) => {
    query = JSON.parse(options.body).query;
    return response({ data: { question: { questionId: '1', titleSlug: 'two-sum', content: '<p>Question</p>', codeSnippets: [], hints: ['Use <code>hashing</code>.', null, 123], companyTags: [{ name: 'Example Labs', slug: 'example' }], companyTagStats: JSON.stringify({ 1: [{ name: 'Example Labs', slug: 'example' }, { name: 'Sample Systems', slug: 'sample' }], 2: [{ name: 'Sample Systems', slug: 'sample' }] }) } } });
  } });
  const problem = await client.problem('two-sum');
  assert.match(query, /hints companyTags/); assert.match(query, /companyTagStats/);
  assert.equal(problem.detailsVersion, 1); assert.deepEqual(problem.hints, ['Use <code>hashing</code>.']);
  assert.deepEqual(problem.companies.map(c => c.name), ['Example Labs', 'Sample Systems']);
  assert.equal(problem.companiesAvailable, true);
});

test('unavailable company fields do not invent tags or prevent opening a problem', async () => {
  const client = new LeetCodeClient({ secrets: secrets(), fetchImpl: async () => response({ data: { question: { questionId: '1', titleSlug: 'two-sum', content: '<p>Question</p>', codeSnippets: [], hints: null, companyTags: null, companyTagStats: null } } }) });
  const problem = await client.problem('two-sum');
  assert.deepEqual(problem.hints, []); assert.deepEqual(problem.companies, []); assert.equal(problem.companiesAvailable, false);
});

test('authenticated submission history uses server pagination and retrieves submitted source and distributions', async () => {
  const calls = [];
  const details = { code: 'server submitted code', statusCode: 10, lang: { name: 'python3' }, question: { titleSlug: 'two-sum' }, user: { username: 'fixture-account' }, runtimePercentile: 95, memoryPercentile: 80, runtimeDistribution: '{"distribution":[[1,100]]}', memoryDistribution: '{"distribution":[[19000,100]]}' };
  const client = new LeetCodeClient({ secrets: secrets(credentials), fetchImpl: async (_url, options) => {
    assert.match(options.headers.Cookie, /LEETCODE_SESSION=/);
    const body = JSON.parse(options.body); calls.push(body);
    return response({ data: body.query.includes('questionSubmissionList') ? { questionSubmissionList: { hasNext: true, lastKey: 'next-page', submissions: [{ id: '2182661615', titleSlug: 'two-sum', timestamp: '1793057511' }] } } : { submissionDetails: details } });
  } });
  const page = await client.submissions('two-sum', { offset: 20, lastKey: 'previous-page' });
  assert.equal(page.submissions[0].id, '2182661615'); assert.equal(page.hasNext, true);
  assert.deepEqual(calls[0].variables, { offset: 20, limit: 20, lastKey: 'previous-page', questionSlug: 'two-sum' });
  assert.deepEqual(await client.submissionDetails('2182661615'), details);
  assert.equal(calls[1].variables.submissionId, 2182661615);
  assert.match(calls[1].query, /runtimeDistribution/); assert.match(calls[1].query, /memoryDistribution/);
  for (const id of ['../other', 'runcode_1.2', '01', '9007199254740992']) await assert.rejects(client.submissionDetails(id));
  await assert.rejects(client.submissions('two-sum', { offset: -1 }));
  assert.equal(calls.length, 2);
});

test('submission history rejects unrelated problems and invalid server data', async () => {
  const client = new LeetCodeClient({ secrets: secrets(credentials), fetchImpl: async () => response({ data: { questionSubmissionList: { hasNext: true, submissions: [{ id: '42', titleSlug: 'other-problem', timestamp: '1793057511' }] } } }) });
  await assert.rejects(client.submissions('two-sum'), { code: 'protocol' });
  client.fetch = async () => response({ data: { submissionDetails: null } });
  await assert.rejects(client.submissionDetails('42'), { code: 'unavailable' });
});

test('submission status lookup requests the verdict without downloading source code', async () => {
  let query;
  const client = new LeetCodeClient({ secrets: secrets(credentials), fetchImpl: async (_url, options) => {
    query = JSON.parse(options.body).query;
    return response({ data: { submissionDetails: { statusCode: '11', question: { titleSlug: 'two-sum' }, user: { username: 'fixture-account' } } } });
  } });
  const details = await client.submissionStatus('42'); assert.equal(details.statusCode, 11);
  assert.ok(!/\bcode\b/.test(query));
  client.fetch = async () => response({ data: { submissionDetails: { statusCode: null, user: { username: 'fixture-account' } } } });
  await assert.rejects(client.submissionStatus('42'), { code: 'unavailable' });
});
