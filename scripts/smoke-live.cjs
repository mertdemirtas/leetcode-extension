'use strict';
// Read-only public checks. This script never signs in, executes code, or submits solutions.
const assert = require('node:assert/strict');
const { LeetCodeClient } = require('../src/client.cjs');
(async () => {
  const client = new LeetCodeClient({ secrets: { get: async () => undefined } });
  const problem = await client.problem('two-sum');
  assert.equal(problem.titleSlug, 'two-sum');
  assert.ok(problem.codeSnippets.some(snippet => snippet.langSlug === 'python3'));
  assert.ok(problem.hints.length > 0);
  assert.ok(problem.hints.every(hint => typeof hint === 'string'));
  assert.ok(Array.isArray(problem.companies));
  assert.equal(typeof problem.companiesAvailable, 'boolean');
  const page = await client.list({ search: 'two sum', limit: 1 });
  assert.ok(page.total > 0); assert.equal(page.questions.length, 1);
  assert.ok(page.questions[0].questionFrontendId);
  const filtered = await client.list({ difficulty: 'Easy', tag: 'array', limit: 3 });
  assert.ok(filtered.questions.length > 0);
  assert.ok(filtered.questions.every(question => question.difficulty === 'Easy' && question.topicTags.some(tag => tag.slug === 'array')));
  console.log(`Live public checks passed: ${problem.title}, ${problem.codeSnippets.length} language templates, hints/company metadata, paginated search, and server-side difficulty/topic filters.`);
})().catch(error => { console.error(`${error.code || 'error'}: ${error.message}`); process.exitCode = 1; });
