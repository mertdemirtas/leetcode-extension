'use strict';

(() => {
  const api = acquireVsCodeApi();
  const app = document.getElementById('app');
  const mode = document.body.dataset.mode;
  const previous = api.getState() || {};
  const ui = { tab: previous.tab || 'cases', caseIndex: previous.caseIndex || 0 };
  const drafts = new Map();
  let state;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const send = (type, fields = {}) => api.postMessage({ type, ...fields });
  const remember = () => api.setState({ tab: ui.tab, caseIndex: ui.caseIndex });
  const button = (action, text, extra = '', cls = '') => `<button type="button" data-action="${action}" class="${cls}" ${extra}>${text}</button>`;
  const difficultyClass = value => ({ Easy: 'difficulty-easy', Medium: 'difficulty-medium', Hard: 'difficulty-hard' }[value] || 'muted');
  const busy = () => state.busy ? 'disabled' : '';
  const errorBanner = () => state.error ? `<div class="error-banner" role="alert"><span>${esc(state.error)}</span>${button('clearError', '×', 'aria-label="Dismiss error"', 'quiet')}</div>` : '';
  const actions = () => `<div class="solution-actions">${button('run', '▷ Run tests', busy())}${button('submit', '↑ Submit', busy(), 'primary')}</div>`;

  function problemRows(questions) {
    return questions.map(p => `<button type="button" class="problem-row ${p.titleSlug === state.problem?.titleSlug ? 'selected' : ''}" data-slug="${esc(p.titleSlug)}"><span class="problem-status ${p.status === 'ac' ? 'good' : 'muted'}">${p.status === 'ac' ? '✓' : '○'}</span><span class="name">${esc(p.questionFrontendId)}. ${esc(p.title)}<small><span class="${difficultyClass(p.difficulty)}">${esc(p.difficulty)}</span>${p.isPaidOnly ? ' · Premium' : ''}</small></span></button>`).join('');
  }

  function sidebar() {
    const c = state.connection;
    const status = state.authorizing ? 'Complete authorization in your browser. Exit cancels sign-in.' : c.status === 'restoring' ? 'Restoring saved session…' : c.status === 'connected' ? `Connected as ${c.username}` : c.status === 'disconnected' ? 'Not connected' : c.error || 'Reconnect to continue';
    app.innerHTML = `<header class="side-controls" aria-label="LeetCode connection controls">${button('connect', 'Connect', busy(), c.status === 'connected' ? '' : 'primary')}${button('refresh', '↻ Refresh', `title="Refresh connection and recover a pending result" ${state.connectionBusy ? 'disabled' : ''}`)}${button('exit', 'Exit', `title="Sign out of LeetCode; keep code and test cases" ${state.connectionBusy && !state.authorizing ? 'disabled' : ''}`)}</header>
      <div class="connection-note ${c.status === 'connected' ? 'good' : 'muted'}" role="status">${esc(status)}</div>${errorBanner()}
      <form class="search" id="problem-search"><input type="search" id="search" aria-label="Search LeetCode problems" placeholder="Search problems…" value="${esc(state.browser.search)}"><button type="submit" title="Search">Search</button></form>
      <div class="side-links">${button('browse', 'All problems', '', 'quiet')}${button('daily', 'Daily challenge', '', 'quiet')}${button('toggleResults', state.resultsVisible ? '▤ Hide results' : '▤ Results', `aria-expanded="${Boolean(state.resultsVisible)}" title="Toggle Tests & Results"`, 'quiet')}${button('chooseSavePath', 'Save folder', '', 'quiet')}</div>
      ${state.problem ? `<section class="current"><p class="current-title">${esc(state.problem.questionFrontendId)}. ${esc(state.problem.title)}</p><label for="language">Language</label> <select id="language" aria-label="Solution language" ${busy()}>${state.problem.codeSnippets.map(s => `<option value="${esc(s.langSlug)}" ${s.langSlug === state.language ? 'selected' : ''}>${esc(s.lang)}</option>`).join('')}</select>${actions()}</section>` : ''}
      ${state.browser.loading ? '<p class="empty" role="status">Loading problems…</p>' : ''}${state.browser.error ? `<p class="empty bad">${esc(state.browser.error)}</p>` : ''}
      ${state.browser.questions.length ? `<div class="group-title">Problems · ${state.browser.total}</div><div class="problem-list">${problemRows(state.browser.questions)}</div>${state.browser.questions.length < state.browser.total ? `<div class="load-more">${button('more', 'Load more', state.browser.loading ? 'disabled' : '')}</div>` : ''}` : !state.browser.loading && !state.browser.error ? `<div class="empty">${state.browser.search ? 'No matching problems.' : `Search by name or number, or choose All problems to browse.`}</div>` : ''}
      ${state.recent.length ? `<div class="group-title">Recent</div><div class="problem-list">${problemRows(state.recent)}</div>` : ''}`;
  }

  function sanitizeProblem(content) {
    const parsed = new DOMParser().parseFromString(content, 'text/html');
    const allowed = new Set(['P','DIV','SPAN','PRE','CODE','STRONG','B','EM','I','U','UL','OL','LI','BLOCKQUOTE','H1','H2','H3','H4','TABLE','THEAD','TBODY','TR','TD','TH','SUB','SUP','BR','HR','A','IMG']);
    const blocked = new Set(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','FORM','INPUT','BUTTON','TEXTAREA','SELECT','SVG','MATH','LINK','META']);
    function clean(node) {
      if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent);
      if (node.nodeType !== Node.ELEMENT_NODE || blocked.has(node.tagName)) return document.createDocumentFragment();
      const element = allowed.has(node.tagName) ? document.createElement(node.tagName.toLowerCase()) : document.createDocumentFragment();
      if (node.tagName === 'A') {
        try { const url = new URL(node.getAttribute('href'), 'https://leetcode.com'); if (url.origin === 'https://leetcode.com' && !url.username && !url.password) { element.setAttribute('href', url.href); element.dataset.external = url.href; } }
        catch { /* Invalid or unsupported links remain plain text. */ }
      }
      if (node.tagName === 'IMG') {
        try { const url = new URL(node.getAttribute('src'), 'https://leetcode.com'); if (['https://assets.leetcode.com','https://leetcode.com'].includes(url.origin)) { element.setAttribute('src', url.href); element.setAttribute('alt', node.getAttribute('alt') || 'Problem diagram'); element.setAttribute('referrerpolicy', 'no-referrer'); } }
        catch { return document.createDocumentFragment(); }
      }
      for (const name of ['colspan', 'rowspan']) if (['TD', 'TH'].includes(node.tagName) && /^\d{1,2}$/.test(node.getAttribute(name))) element.setAttribute(name, node.getAttribute(name));
      for (const child of node.childNodes) element.appendChild(clean(child));
      return element;
    }
    const result = document.createDocumentFragment();
    for (const child of parsed.body.childNodes) result.appendChild(clean(child));
    return result;
  }

  function description() {
    const p = state.problem;
    if (!p) { app.innerHTML = '<p class="empty">Choose a problem from the LeetCode sidebar.</p>'; return; }
    app.innerHTML = `<div class="description"><div class="description-heading"><h1>${esc(p.questionFrontendId)}. ${esc(p.title)}</h1>${button('problemLink', '↗', 'aria-label="Open problem on LeetCode"', 'quiet')}</div><div class="tags"><span class="tag ${difficultyClass(p.difficulty)}">${esc(p.difficulty)}</span>${(p.topicTags || []).map(tag => `<span class="tag">${esc(tag.name)}</span>`).join('')}</div><details class="companies"><summary>Companies${p.companies?.length ? ` · ${p.companies.length}` : ''}</summary><div class="company-tags">${p.companies?.length ? p.companies.map(company => `<span class="tag">${esc(company.name)}</span>`).join('') : `<p class="muted">${p.companiesAvailable ? 'No company tags for this problem.' : 'Company tags are unavailable for this account.'}</p>`}</div></details><article class="statement" id="statement"></article>${p.hints?.length ? `<section class="hints" aria-label="Problem hints"><h2>Hints</h2>${p.hints.map((_hint, index) => `<details><summary>Hint ${index + 1}</summary><div class="hint-body" id="hint-${index}"></div></details>`).join('')}</section>` : ''}</div>`;
    document.getElementById('statement').appendChild(sanitizeProblem(p.content));
    (p.hints || []).forEach((hint, index) => document.getElementById(`hint-${index}`).appendChild(sanitizeProblem(hint)));
  }

  function tabs() {
    return `<header class="result-header" aria-label="LeetCode output"><div role="tablist" aria-label="Test output">${['cases', 'results', 'history'].map(tab => `<button type="button" role="tab" id="tab-${tab}" data-tab="${tab}" aria-controls="output" aria-selected="${ui.tab === tab}">${tab === 'cases' ? 'Test cases' : tab === 'results' ? 'Results' : 'History'}</button>`).join('')}</div></header>`;
  }

  function caseTabs(cases, editable) {
    return `<div class="case-tabs">${cases.map((c, index) => `<button type="button" data-case="${index}" aria-pressed="${index === ui.caseIndex}">${c.passed === true ? '<span class="good">✓</span>' : c.passed === false ? '<span class="bad">×</span>' : ''}${esc(c.name || `Case ${index + 1}`)}</button>`).join('')}${editable ? button('addCase', '+ Add case', cases.length >= 50 ? 'disabled' : '', 'add') : ''}</div>`;
  }

  function casesContent() {
    const cases = state.cases;
    if (!cases.length) return '<p class="empty">Open a problem to edit its test cases.</p>';
    ui.caseIndex = Math.min(ui.caseIndex, cases.length - 1);
    const testcase = cases[ui.caseIndex];
    return `${caseTabs(cases, true)}<div class="case-fields"><label>Input · one argument per line<textarea data-field="input" spellcheck="false" placeholder="[2,7,11,15]&#10;9">${esc(testcase.input)}</textarea></label></div><div class="case-note">${button('deleteCase', 'Remove case', cases.length <= 1 ? 'disabled' : '', 'quiet')}</div>${actions()}`;
  }

  const formatTime = value => new Date(value).toLocaleString();
  const titleOf = record => record.result?.verdict || ({ sending: 'Sending…', prepared: 'Saving snapshot…', pending: 'Waiting for a result', uncertain: 'Delivery unconfirmed', failed: 'Request failed', reviewed: 'Reviewed in browser' }[record.status] || record.status);
  const colorOf = record => record.result?.passed || record.result?.accepted ? 'good' : record.result ? 'bad' : ['uncertain', 'pending', 'sending'].includes(record.status) ? 'warn' : 'muted';

  function beats(value) {
    const valid = ['number', 'string'].includes(typeof value) && String(value).trim() && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 100;
    return valid ? `Beats ${Number(value).toFixed(2)}%` : 'Beats unavailable';
  }

  function distributionChart(result, metric) {
    const bins = result[metric + 'Distribution'];
    if (!Array.isArray(bins) || !bins.length) return '';
    const points = bins.filter(bin => Array.isArray(bin) && bin.length === 2 && bin.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0));
    if (!points.length) return '';
    const value = result[metric + 'Value'];
    const hasValue = typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const minimum = Math.min(...points.map(bin => bin[0]), ...(hasValue ? [value] : []));
    const maximum = Math.max(...points.map(bin => bin[0]), ...(hasValue ? [value] : []));
    const span = maximum - minimum || 1, count = Math.min(32, points.length);
    const groups = Array.from({ length: count }, () => 0);
    for (const [position, share] of points) groups[Math.min(count - 1, Math.floor((position - minimum) / span * count))] += share;
    const peak = Math.max(...groups) || 1;
    const label = metric === 'runtime' ? 'Runtime' : 'Memory';
    const units = position => metric === 'runtime' ? `${Number(position.toFixed(2))} ms` : `${Number((position / 1000).toFixed(2))} MB`;
    const bars = groups.map((share, index) => `<rect class="chart-bar" x="${16 + index * 288 / count}" y="${96 - share / peak * 72}" width="${Math.max(1, 288 / count - 2)}" height="${share / peak * 72}"><title>${esc(units(minimum + index / count * span))}–${esc(units(minimum + (index + 1) / count * span))}: ${share.toFixed(2)}% of submissions</title></rect>`).join('');
    const marker = hasValue ? 16 + (value - minimum) / span * 288 : null;
    return `<svg class="distribution-chart" viewBox="0 0 320 126" role="img" aria-label="${label} distribution${hasValue ? `; your result ${esc(units(value))}` : ''}"><title>${label} distribution across LeetCode submissions</title>${bars}<line class="chart-axis" x1="16" y1="97" x2="304" y2="97"/>${hasValue ? `<line class="chart-marker" x1="${marker}" y1="18" x2="${marker}" y2="98"/><circle class="chart-marker-dot" cx="${marker}" cy="18" r="3"/><text class="chart-caption" x="${Math.min(284, Math.max(36, marker))}" y="10" text-anchor="middle">You</text>` : ''}<text class="chart-caption" x="16" y="116">${esc(units(minimum))}</text><text class="chart-caption" x="304" y="116" text-anchor="end">${esc(units(maximum))}</text></svg>`;
  }

  const metricCard = (result, metric, label) => `<div class="metric"><label>${label}</label><div class="value">${esc(result[metric] || 'Not returned')}</div><div class="beats">${beats(result[metric + 'Percentile'])}</div>${distributionChart(result, metric)}</div>`;

  function io(input, actual, failed = false) {
    return `<div class="io"><div><label>Input</label><pre>${esc(input || 'Not provided by LeetCode')}</pre></div><div><label>Your output</label><pre class="${failed ? 'failed' : ''}">${esc(actual ?? 'Not returned')}</pre></div></div>`;
  }

  function resultContent() {
    const r = state.record;
    if (!r) return '<p class="empty">Run tests or submit to see results.</p>';
    const result = r.result;
    let content = `<div class="result-title"><div><h2 class="${colorOf(r)}">${esc(titleOf(r))}</h2><div class="meta">${r.kind === 'run' ? 'Test run' : 'Submission'}${result?.totalCases !== null && result?.totalCases !== undefined ? ` · ${esc(result.totalCorrect ?? '—')} / ${esc(result.totalCases)} passed` : ''}</div></div>${state.changedSinceRun ? '<small class="warn">Code changed since this attempt</small>' : ''}</div>`;
    if (!result) {
      content += `<div class="pending"><p>${esc(r.error || (state.busy ? 'Running on LeetCode…' : 'Check the pending result.'))}</p>${r.status === 'uncertain' ? r.kind === 'submit' ? '<p>Check LeetCode history before sending another submission.</p>' : '<p>You can run these tests again.</p>' : ''}<div class="result-actions">${r.remoteId && r.status === 'pending' ? button('resume', '↻ Check status', `data-id="${esc(r.id)}" ${busy()}`) : ''}${['uncertain','pending'].includes(r.status) ? r.kind === 'submit' ? button('submissionHistory', 'Open LeetCode history') + (r.local === false ? '' : button('markReviewed', 'I checked history · mark reviewed', `data-id="${esc(r.id)}" ${busy()}`, 'quiet')) : button('run', 'Run tests again', busy()) : ''}</div></div>`;
    } else if (result.error) content += `<pre class="judge-error">${esc(result.error)}</pre>`;
    else if (result.accepted) {
      content += `<div class="metrics">${metricCard(result, 'runtime', 'Runtime')}${metricCard(result, 'memory', 'Memory')}</div>`;
    } else if (r.kind === 'run' && result.cases.length) {
      ui.caseIndex = Math.min(ui.caseIndex, result.cases.length - 1);
      const c = result.cases[ui.caseIndex];
      content += caseTabs(result.cases, false) + io(c.input, c.actual, c.passed === false);
    } else {
      content += io(result.failingInput, result.actual, true);
      if (result.failingInput) content += `<div class="result-actions">${button('addFailed', '+ Add failing input to test cases')}</div>`;
    }
    if (result?.stdout?.some(Boolean)) content += `<details class="details"><summary>Standard output</summary><pre class="stdout">${esc(result.stdout.join('\n'))}</pre></details>`;
    if (r.kind === 'submit' && r.remoteId) content += `<div class="result-actions">${button('submissionLink', 'View on LeetCode', `data-id="${esc(r.remoteId)}"`, 'quiet')}</div>`;
    return content;
  }

  function historyContent() {
    const page = state.submissionHistory || {};
    const records = state.history.filter(record => record.kind === 'submit');
    return `<div class="history-controls">${button('loadHistory', page.loading ? 'Loading submissions…' : '↻ Refresh submissions', page.loading ? 'disabled' : '', 'quiet')}</div>${page.error ? `<p class="muted" role="status">${esc(page.error)}</p>` : ''}${records.length ? `<table class="history"><thead><tr><th>Verdict</th><th>Language</th><th class="optional">When</th><th>Code</th></tr></thead><tbody>${records.map(r => `<tr><td>${button('selectAttempt', esc(titleOf(r)), `data-id="${esc(r.id)}"`, colorOf(r))}</td><td>${esc(r.language)}</td><td class="optional">${esc(formatTime(r.createdAt))}</td><td>${button('snapshot', 'View code', `data-id="${esc(r.id)}" title="Open this submission's code"`, 'quiet')}</td></tr>`).join('')}</tbody></table>` : !page.loading ? '<p class="empty">No submissions for this problem yet.</p>' : ''}${page.hasNext ? `<div class="load-more">${button('moreHistory', 'Load older submissions', page.loading ? 'disabled' : '')}</div>` : ''}`;
  }

  function results() {
    app.innerHTML = `${tabs()}${ui.tab === 'results' && state.error === state.record?.error ? '' : errorBanner()}<section id="output" role="tabpanel" aria-labelledby="tab-${ui.tab}" class="output" aria-live="polite">${ui.tab === 'cases' ? casesContent() : ui.tab === 'history' ? historyContent() : resultContent()}</section>`;
  }

  function render() { if (mode === 'problems') sidebar(); else if (mode === 'description') description(); else results(); }
  function saveDraft() {
    if (!state.problem) return;
    drafts.set(state.problem.titleSlug, structuredClone(state.cases));
    send('saveCases', { slug: state.problem.titleSlug, cases: state.cases });
  }

  app.addEventListener('submit', event => { event.preventDefault(); if (event.target.id === 'problem-search') send('search', { search: document.getElementById('search').value }); });
  app.addEventListener('input', event => {
    if (event.target.dataset.field) { state.cases[ui.caseIndex][event.target.dataset.field] = event.target.value; saveDraft(); }
  });
  app.addEventListener('change', event => { if (event.target.id === 'language') send('openProblem', { slug: state.problem.titleSlug, language: event.target.value }); });
  app.addEventListener('click', event => {
    const link = event.target.closest('[data-external]');
    if (link) { event.preventDefault(); send('openExternal', { url: link.dataset.external }); return; }
    const target = event.target.closest('button');
    if (!target) return;
    if (target.dataset.slug) { send('openProblem', { slug: target.dataset.slug }); return; }
    if (target.dataset.tab) { ui.tab = target.dataset.tab; remember(); render(); if (ui.tab === 'history') send('loadHistory'); return; }
    if (target.dataset.case !== undefined) { ui.caseIndex = Number(target.dataset.case); remember(); render(); return; }
    const action = target.dataset.action;
    if (['connect','refresh','exit','daily','more','showResults','toggleResults','minimize','clearError','chooseSavePath','loadHistory','moreHistory'].includes(action)) send(action);
    else if (action === 'browse') send('search', { search: '' });
    else if (action === 'run' || action === 'submit') { ui.tab = 'results'; remember(); send(action, { slug: state.problem.titleSlug, ...(mode === 'results' ? { cases: state.cases } : {}) }); }
    else if (action === 'addCase') { state.cases.push({ name: `Case ${state.cases.length + 1}`, input: '' }); ui.caseIndex = state.cases.length - 1; saveDraft(); render(); }
    else if (action === 'deleteCase' && state.cases.length > 1) { state.cases.splice(ui.caseIndex, 1); ui.caseIndex = Math.max(0, ui.caseIndex - 1); saveDraft(); render(); }
    else if (action === 'addFailed') { state.cases.push({ name: 'Failed submission', input: state.record.result.failingInput }); ui.tab = 'cases'; ui.caseIndex = state.cases.length - 1; saveDraft(); render(); remember(); }
    else if (action === 'selectAttempt') { ui.tab = 'results'; remember(); send(action, { id: target.dataset.id }); }
    else if (['resume','snapshot','markReviewed'].includes(action)) send(action, { id: target.dataset.id });
    else if (action === 'problemLink') send('openExternal', { url: `https://leetcode.com/problems/${state.problem.titleSlug}/` });
    else if (action === 'submissionHistory') send('openExternal', { url: `https://leetcode.com/problems/${state.problem.titleSlug}/submissions/` });
    else if (action === 'submissionLink' && /^\d+$/.test(target.dataset.id)) send('openExternal', { url: `https://leetcode.com/submissions/detail/${target.dataset.id}/` });
  });

  window.addEventListener('message', event => {
    if (event.data?.type === 'casesSaved') {
      const { slug, cases } = event.data;
      const draft = drafts.get(slug);
      const fields = values => values.map(c => [c.name, c.input]);
      if (draft && JSON.stringify(fields(draft)) === JSON.stringify(fields(cases))) drafts.delete(slug);
      if (state?.problem?.titleSlug === slug && !drafts.has(slug)) state.cases = cases;
      return;
    }
    if (event.data?.type !== 'state') return;
    const next = event.data.state;
    const previousRecord = state?.record;
    const selectedChanged = state?.problem?.titleSlug !== next.problem?.titleSlug;
    if (next.problem && drafts.has(next.problem.titleSlug)) next.cases = structuredClone(drafts.get(next.problem.titleSlug));
    if (selectedChanged) ui.caseIndex = 0;
    if (next.record && (next.record.id !== previousRecord?.id || next.record.status !== previousRecord?.status)) { ui.tab = 'results'; remember(); }
    state = next;
    if (mode === 'results' && ui.tab === 'history' && selectedChanged) send('loadHistory');
    const focused = document.activeElement;
    if (mode === 'results' && ui.tab === 'cases' && focused?.dataset.field && !selectedChanged) return;
    if (mode === 'problems' && focused?.id === 'search' && !next.browser.loading) return;
    render();
  });
  send('ready');
})();
