'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { constants } = require('node:fs');
const { validateSlug } = require('./client.cjs');

function resolveSavePath(setting, workspace, home = os.homedir()) {
  if (typeof setting !== 'string' || setting.includes('\0') || setting.length > 8192) throw new Error('Enter a valid LeetCode save path in extension settings.');
  let configured = setting.trim();
  if (configured === '~') configured = home;
  else if (/^~[\\/]/.test(configured)) configured = path.join(home, configured.slice(2));
  if (path.isAbsolute(configured)) return path.normalize(configured);
  if (!workspace) throw new Error('Open a local workspace or set an absolute LeetCode save path in extension settings.');
  return path.resolve(workspace, configured || 'leetcode');
}

async function prepareFiles({ savePath, workspace, problem, language, extension, starter, defaultCases, savedCases, legacySolution }) {
  if (!/^[a-z0-9]+$/.test(language) || !/^[a-z0-9]+$/.test(extension)) throw new Error('Invalid solution language or file extension.');
  const base = resolveSavePath(savePath, workspace);
  const slug = validateSlug(problem.titleSlug);
  const solution = path.join(base, `${slug}.${extension}`);
  const previous = legacySolution || path.join(base, slug, `${language}.${extension}`);
  const legacyDirectory = path.basename(previous) === `${language}.${extension}` && path.basename(path.dirname(previous)) === slug ? path.dirname(previous) : path.join(base, slug);
  let cases = savedCases;
  if (!cases) {
    try { cases = JSON.parse(await fs.readFile(path.join(legacyDirectory, 'testcases.json'), 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('The existing test case file could not be imported. It has been preserved; repair it before continuing.');
    }
  }
  cases ||= defaultCases;
  if (!Array.isArray(cases) || !cases.length || cases.length > 50 || JSON.stringify(cases).length > 200000 || cases.some(c => !c || typeof c.input !== 'string')) throw new Error('Test cases must contain 1–50 objects with an input string. Existing files have been preserved.');
  await fs.mkdir(base, { recursive: true });
  let create = path.resolve(previous) === solution;
  if (!create) {
    try { await fs.copyFile(previous, solution, constants.COPYFILE_EXCL); }
    catch (error) {
      if (error.code === 'ENOENT') create = true;
      else if (error.code !== 'EEXIST') throw error;
    }
  }
  if (create) {
    try { await fs.writeFile(solution, starter + '\n', { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  return { solution, cases: cases.map((c, i) => ({ name: String(c.name || `Case ${i + 1}`).slice(0, 80), input: c.input })) };
}

module.exports = { resolveSavePath, prepareFiles };
