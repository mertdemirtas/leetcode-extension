'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { prepareFiles, resolveSavePath } = require('../src/files.cjs');

test('save-path setting supports absolute, workspace-relative, home, and default paths', () => {
  assert.equal(resolveSavePath('', '/work'), path.resolve('/work/leetcode'));
  assert.equal(resolveSavePath('practice/algorithms', '/work'), path.resolve('/work/practice/algorithms'));
  assert.equal(resolveSavePath('/practice/problems', undefined), path.resolve('/practice/problems'));
  assert.equal(resolveSavePath('~/problems', undefined, '/my-home'), path.resolve('/my-home/problems'));
  assert.throws(() => resolveSavePath('', undefined), /absolute LeetCode save path/);
});

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-path-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { savePath: directory, problem: { titleSlug: 'two-sum', title: 'Two Sum' }, language: 'python3', extension: 'py', starter: 'class Solution: pass', defaultCases: [{ name: 'Case 1', input: '[2,7]\n9' }] };
}

test('opening problems creates only named solution files directly in the configured folder', async t => {
  const options = await fixture(t);
  const first = await prepareFiles(options);
  assert.equal(first.solution, path.join(options.savePath, 'two-sum.py'));
  assert.deepEqual(await fs.readdir(options.savePath), ['two-sum.py']);
  await fs.writeFile(first.solution, 'my existing solution\n');
  await prepareFiles(options);
  assert.equal(await fs.readFile(first.solution, 'utf8'), 'my existing solution\n');
  await prepareFiles({ ...options, language: 'cpp', extension: 'cpp' });
  assert.deepEqual((await fs.readdir(options.savePath)).sort(), ['two-sum.cpp', 'two-sum.py']);
});

test('legacy solutions and custom cases are imported without overwriting either source', async t => {
  const options = await fixture(t);
  const legacy = path.join(options.savePath, 'two-sum'); await fs.mkdir(legacy);
  await fs.writeFile(path.join(legacy, 'python3.py'), 'my saved solution\n');
  const oldCases = '[{"input":"[3,3]\\n6","expected":"[0,1]"}]';
  await fs.writeFile(path.join(legacy, 'testcases.json'), oldCases);
  const files = await prepareFiles(options);
  assert.equal(await fs.readFile(files.solution, 'utf8'), 'my saved solution\n');
  assert.deepEqual(files.cases, [{ name: 'Case 1', input: '[3,3]\n6' }]);
  assert.equal(await fs.readFile(path.join(legacy, 'testcases.json'), 'utf8'), oldCases);
  assert.equal(await fs.readFile(path.join(legacy, 'python3.py'), 'utf8'), 'my saved solution\n');
  await fs.writeFile(files.solution, 'newer flat solution');
  const cached = [{ name: 'Custom', input: '[1,2]\n3' }];
  const reopened = await prepareFiles({ ...options, savedCases: cached });
  assert.equal(await fs.readFile(reopened.solution, 'utf8'), 'newer flat solution');
  assert.deepEqual(reopened.cases, cached);
});

test('changing the save path copies known solution work while preserving the previous location', async t => {
  const options = await fixture(t);
  const previous = await prepareFiles(options); await fs.writeFile(previous.solution, 'my work');
  const nextPath = path.join(options.savePath, 'new-location');
  const next = await prepareFiles({ ...options, savePath: nextPath, legacySolution: previous.solution });
  assert.equal(await fs.readFile(next.solution, 'utf8'), 'my work');
  assert.equal(await fs.readFile(previous.solution, 'utf8'), 'my work');
  assert.deepEqual(await fs.readdir(nextPath), ['two-sum.py']);
});

test('invalid legacy cases are preserved and cannot replace cached private cases', async t => {
  const options = await fixture(t);
  const legacy = path.join(options.savePath, 'two-sum'); await fs.mkdir(legacy);
  await fs.writeFile(path.join(legacy, 'testcases.json'), '{broken');
  await assert.rejects(prepareFiles(options), /preserved/);
  assert.equal(await fs.readFile(path.join(legacy, 'testcases.json'), 'utf8'), '{broken');
  const files = await prepareFiles({ ...options, savedCases: options.defaultCases });
  assert.deepEqual(files.cases, options.defaultCases);
});
