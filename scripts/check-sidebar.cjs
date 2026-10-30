'use strict';
const assert = require('node:assert/strict');

// Shared checks exercise actual webview messages against each isolated IDE host.
module.exports = async function checkSidebar(frame) {
  const ready = fn => frame.waitForFunction(fn, { polling: 100, timeout: 15000 });
  const click = selector => frame.locator(selector).setTimeout(15000).click();
  const expand = async key => { if (!await frame.$eval(`[data-group="${key}"]`, node => node.open)) await click(`[data-group="${key}"] summary`); };
  await expand('difficulty'); await click('[data-difficulty="Medium"]');
  await ready(() => document.querySelector('.problem-list [data-slug="three-sum"]'));
  await expand('tag'); await click('[data-tag="hash-table"]');
  await ready(() => document.querySelector('.active-filters')?.textContent.includes('Hash Table') && document.querySelector('.problem-list [data-slug="three-sum"]'));
  await expand('company'); await click('[data-company="google"]');
  await ready(() => document.querySelector('.active-filters')?.textContent.includes('Google') && document.querySelector('.problem-list [data-slug="three-sum"]'));
  assert.ok(await frame.$('.problem-list [data-slug="three-sum"]'), 'Company list must include a problem never opened locally');
  await click('[data-action="browse"]');
  await ready(() => document.querySelector('.problem-list [data-slug="two-sum"]') && !document.querySelector('.active-filters'));
  await click('[data-action="toggleSearch"]');
  await frame.$eval('#search', input => { input.focus(); input.value='two sum'; input.dispatchEvent(new Event('input',{bubbles:true})); });
  await ready(() => document.querySelector('[role="option"][data-recommend-slug="two-sum"]'));
  assert.equal(await frame.$eval('#search', input => input.value), 'two sum');
  const input=await frame.$('#search'); await input.press('ArrowDown'); await input.press('Enter'); await input.dispose();
  await ready(() => document.getElementById('problem-suggestions').hidden);
  await click('[data-action="toggleSearch"]');
  assert.equal(await frame.$eval('.search-area', element=>element.hidden), true);
  console.log('Native sidebar checked: difficulty, topic, company, clear filters, and keyboard selection of live suggestions.');
};
