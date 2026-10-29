'use strict';

(() => {
  const api = acquireVsCodeApi();
  const app = document.getElementById('app');
  const mode = document.body.dataset.mode;
  const previous = api.getState() || {};
  const ui = { tab: previous.tab || 'cases', caseIndex: previous.caseIndex || 0, groups: previous.groups || { all: true }, searchOpen: Boolean(previous.searchOpen), menuOpen: false, company: previous.company || null, disclosures: previous.disclosures || {} };
  const drafts = new Map();
  const chartCache = new WeakMap();
  let chartFrame;
  Object.assign(ui, { performanceId: null, performanceLoading: false, performanceError: null, performanceRequest: 0 });
  let state;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const send = (type, fields = {}) => api.postMessage({ type, ...fields });
  const remember = () => api.setState({ tab: ui.tab, caseIndex: ui.caseIndex, groups: ui.groups, searchOpen: ui.searchOpen, company: ui.company, disclosures: ui.disclosures });
  const button = (action, text, extra = '', cls = '') => `<button type="button" data-action="${action}" class="${cls}" ${extra}>${text}</button>`;
  const difficultyClass = value => ({ Easy: 'difficulty-easy', Medium: 'difficulty-medium', Hard: 'difficulty-hard' }[value] || 'muted');
  const busy = () => state.busy ? 'disabled' : '';
  const errorBanner = () => state.error ? `<div class="error-banner" role="alert"><span>${esc(state.error)}</span>${button('clearError', '×', 'aria-label="Dismiss error"', 'quiet')}</div>` : '';
  const paths = {
    connect: '<path d="m6 3 2 2m4-2-2 2M5 8l3-3 3 3-3 3zm6 0 2 2m-5 1-2 2H3v-3l2-2"/>',
    search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>',
    refresh: '<path d="M13 6a5.3 5.3 0 1 0 .2 4M13 2v4H9"/>',
    exit: '<path d="M6 2H3v12h3m3-9 3 3-3 3m-3-3h8"/>',
    more: '<circle cx="3" cy="8" r=".7"/><circle cx="8" cy="8" r=".7"/><circle cx="13" cy="8" r=".7"/>',
    chevron: '<path d="m6 4 4 4-4 4"/>',
    panel: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 10h12"/>',
    folder: '<path d="M2 5V3.5h4l2 2h6v7H2zM2 7h12"/>',
    bookmark: '<path d="M4 2.5h8v11l-4-2.5-4 2.5z"/>',
    external: '<path d="M9 2h5v5M14 2 7 9m-1-6H2v11h11v-4"/>',
    check: '<circle cx="8" cy="8" r="6"/><path d="m5 8 2 2 4-4"/>',
    cross: '<circle cx="8" cy="8" r="6"/><path d="m6 6 4 4m0-4-4 4"/>',
    timer: '<circle cx="8" cy="9" r="5"/><path d="M6 1h4M8 4v5l2 1m2-7 1 1"/>',
    memory: '<rect x="2" y="4" width="12" height="7" rx="1"/><path d="M5 6v3m3-3v3m3-3v3M4 11v2m3-2v2m3-2v2"/>',
  };
  const icon = name => `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
  const iconButton = (action, name, label, extra = '', cls = '') => button(action, icon(name), `aria-label="${esc(label)}" title="${esc(label)}" ${extra}`, `icon-button quiet ${cls}`);

  function problemRows(questions) {
    return questions.map(p => `<button type="button" class="problem-row ${difficultyClass(p.difficulty)} ${p.titleSlug === state.problem?.titleSlug ? 'selected' : ''}" data-slug="${esc(p.titleSlug)}" aria-pressed="${p.titleSlug === state.problem?.titleSlug}" aria-label="${esc(`${p.questionFrontendId}. ${p.title}, ${p.difficulty}${p.status === 'ac' ? ', solved' : ''}${p.isPaidOnly ? ', Premium' : ''}`)}" title="${esc(`${p.title} · ${p.difficulty}${p.isPaidOnly ? ' · Premium' : ''}`)}"><span class="problem-status good">${p.status === 'ac' ? '✓' : ''}</span><span class="problem-number">[${esc(p.questionFrontendId)}]</span><span class="name">${esc(p.title)}</span><span class="problem-level">${esc(p.difficulty?.[0] || '')}${p.isPaidOnly ? ' ·' : ''}</span></button>`).join('');
  }

  const group = (key, label, content) => `<details class="browser-group" data-group="${key}" ${ui.groups[key] ? 'open' : ''}><summary>${icon('chevron')}<span>${esc(label)}</span></summary><div class="group-body">${content}</div></details>`;

  function sidebar() {
    const c = state.connection;
    const status = state.authorizing ? 'Complete authorization in your browser. Exit cancels sign-in.' : c.status === 'restoring' ? 'Restoring saved session…' : c.status === 'connected' ? `Connected as ${c.username}` : c.status === 'disconnected' ? 'Not connected' : c.error || 'Reconnect to continue';
    const filters = state.browser.filters || { difficulty: '', tag: null };
    const known = (state.knownProblems || []).map(problem => ({ ...problem, status: state.browser.questions.find(item => item.titleSlug === problem.titleSlug)?.status || problem.status }));
    const topics = new Map(), companies = new Map();
    for (const p of [...known, ...state.browser.questions]) for (const tag of p.topicTags || []) if (tag.slug) topics.set(tag.slug, tag);
    for (const p of known) for (const company of p.companies || []) companies.set(company.slug, company);
    const rows = ui.company ? known.filter(p => p.companies?.some(company => company.slug === ui.company.slug) && (!filters.difficulty || p.difficulty === filters.difficulty) && (!filters.tag || p.topicTags?.some(tag => tag.slug === filters.tag.slug)) && `${p.questionFrontendId} ${p.title}`.toLowerCase().includes(state.browser.search.toLowerCase())) : state.browser.questions;
    const filterNames = [filters.difficulty, filters.tag?.name, ui.company?.name].filter(Boolean);
    const activeFilter = filterNames.length || state.browser.search;
    const list = `${activeFilter ? `<div class="active-filters"><span>${esc([state.browser.search, ...filterNames].filter(Boolean).join(' · '))}</span>${button('browse', 'Clear', '', 'quiet')}</div>` : ''}${state.browser.loading ? '<p class="browser-note" role="status">Loading problems…</p>' : ''}${state.browser.error ? `<p class="browser-note bad">${esc(state.browser.error)}</p>` : ''}<div class="problem-list">${problemRows(rows)}</div>${!rows.length && !state.browser.loading ? `<p class="browser-note">${activeFilter ? 'No matching problems.' : 'Search or browse LeetCode problems.'}</p>${button('browse', 'Browse problems', '', 'quiet')}` : ''}${!ui.company && rows.length < state.browser.total ? `<div class="load-more">${button('more', 'Load more', state.browser.loading ? 'disabled' : '', 'quiet')}</div>` : ''}${ui.company ? '<p class="browser-note">From opened problems</p>' : rows.length ? `<p class="browser-note catalog-count">${rows.length} of ${esc(state.browser.total)}</p>` : ''}`;
    app.innerHTML = `<header class="side-controls"><span class="side-label">LEETCODE</span><div class="side-icons" aria-label="LeetCode connection controls">${iconButton('connect', 'connect', c.status === 'connected' ? `Connected as ${c.username}` : 'Connect to LeetCode', `${busy()} aria-pressed="${c.status === 'connected'}"`, c.status === 'connected' ? 'good' : '')}${iconButton('toggleSearch', 'search', 'Search problems', `aria-expanded="${ui.searchOpen}"`)}${iconButton('refresh', 'refresh', 'Refresh connection', state.connectionBusy ? 'disabled' : '')}${iconButton('exit', 'exit', 'Exit and sign out', state.connectionBusy && !state.authorizing ? 'disabled' : '')}${iconButton('toggleMenu', 'more', 'More LeetCode actions', `aria-expanded="${ui.menuOpen}"`)}</div></header>
      <div class="connection-note ${c.status === 'connected' && !state.authorizing ? 'sr-only' : 'muted'}" role="status">${esc(status)}</div>${errorBanner()}
      ${ui.menuOpen ? `<div class="side-menu">${button('daily', 'Daily challenge', '', 'quiet')}${button('settings', 'Extension settings', '', 'quiet')}${button('chooseSavePath', 'Choose save folder', '', 'quiet')}</div>` : ''}
      <form class="search" id="problem-search" ${ui.searchOpen || state.browser.search ? '' : 'hidden'}><input type="search" id="search" aria-label="Search LeetCode problems" maxlength="150" placeholder="Find a problem…" value="${esc(state.browser.search)}"><button type="submit" class="icon-button quiet" aria-label="Search" title="Search">${icon('search')}</button></form>
      <div class="browser-groups">${group('all', 'All', list)}${group('difficulty', 'Difficulty', ['Easy','Medium','Hard'].map(level => button('filterDifficulty', esc(level), `data-difficulty="${level}" aria-pressed="${filters.difficulty === level}"`, `filter-button ${difficultyClass(level)}`)).join(''))}${group('tag', 'Tag', topics.size ? [...topics.values()].sort((a,b) => a.name.localeCompare(b.name)).map(tag => button('filterTag', esc(tag.name), `data-tag="${esc(tag.slug)}" data-name="${esc(tag.name)}" aria-pressed="${filters.tag?.slug === tag.slug}"`, 'filter-button')).join('') : '<p class="browser-note">Tags appear as problems load.</p>')}${group('company', 'Company', companies.size ? [...companies.values()].sort((a,b) => a.name.localeCompare(b.name)).map(company => button('filterCompany', esc(company.name), `data-company="${esc(company.slug)}" data-name="${esc(company.name)}" aria-pressed="${ui.company?.slug === company.slug}"`, 'filter-button')).join('') + '<p class="browser-note">From opened problems</p>' : '<p class="browser-note">Open a problem to see available company tags.</p>')}${group('favorite', 'Favorite', problemRows(known.filter(p => state.favorites?.includes(p.titleSlug))) || '<p class="browser-note">Save a problem with its bookmark button.</p>')}</div>
      <footer class="side-footer">${button('toggleResults', icon('panel') + 'Results', `aria-expanded="${Boolean(state.resultsVisible)}" title="Toggle Tests & Results"`, 'quiet')}${button('chooseSavePath', icon('folder') + 'Save folder', '', 'quiet')}</footer>`;
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
    app.innerHTML = `<div class="description"><div class="description-label"><span>Problem</span><div>${iconButton('toggleFavorite', 'bookmark', state.favorites?.includes(p.titleSlug) ? 'Remove favorite' : 'Favorite this problem', `aria-pressed="${Boolean(state.favorites?.includes(p.titleSlug))}"`)}${iconButton('problemLink', 'external', 'Open problem on LeetCode')}</div></div><div class="description-heading"><h1>${esc(p.questionFrontendId)}. ${esc(p.title)}</h1></div><div class="tags"><span class="${difficultyClass(p.difficulty)}">${esc(p.difficulty)}</span>${(p.topicTags || []).map(tag => `<span class="tag">${esc(tag.name)}</span>`).join('')}</div><article class="statement" id="statement"></article><details class="companies" data-disclosure="${esc(p.titleSlug)}:companies" ${ui.disclosures[p.titleSlug + ':companies'] ? 'open' : ''}><summary>Companies${p.companies?.length ? ` · ${p.companies.length}` : ''}</summary><div class="company-tags">${p.companies?.length ? p.companies.map(company => `<span class="tag">${esc(company.name)}</span>`).join('') : `<p class="muted">${p.companiesAvailable ? 'No company tags for this problem.' : 'Company tags are unavailable for this account.'}</p>`}</div></details>${p.hints?.length ? `<section class="hints" aria-label="Problem hints"><h2>Hints · ${p.hints.length}</h2>${p.hints.map((_hint, index) => `<details data-disclosure="${esc(p.titleSlug)}:hint-${index}" ${ui.disclosures[p.titleSlug + ':hint-' + index] ? 'open' : ''}><summary>Hint ${index + 1}</summary><div class="hint-body" id="hint-${index}"></div></details>`).join('')}</section>` : ''}</div>`;
    document.getElementById('statement').appendChild(sanitizeProblem(p.content));
    (p.hints || []).forEach((hint, index) => document.getElementById(`hint-${index}`).appendChild(sanitizeProblem(hint)));
  }

  function tabs() {
    return `<header class="result-header" aria-label="LeetCode output"><div role="tablist" aria-label="Test output">${['cases', 'results', 'history'].map(tab => `<button type="button" role="tab" id="tab-${tab}" data-tab="${tab}" aria-controls="output" aria-selected="${ui.tab === tab}">${tab === 'cases' ? 'Test cases' : tab === 'results' ? 'Results' : 'Submissions'}</button>`).join('')}</div></header>`;
  }

  function caseTabs(cases, editable) {
    return `<div class="case-tabs">${cases.map((c, index) => `<button type="button" data-case="${index}" aria-pressed="${index === ui.caseIndex}">${c.passed === true ? '<span class="good">✓</span>' : c.passed === false ? '<span class="bad">×</span>' : ''}${esc(c.name || `Case ${index + 1}`)}</button>`).join('')}${editable ? button('addCase', '+ Add case', cases.length >= 50 ? 'disabled' : '', 'add') : ''}</div>`;
  }

  function casesContent() {
    const cases = state.cases;
    if (!cases.length) return '<p class="empty">Open a problem to edit its test cases.</p>';
    ui.caseIndex = Math.min(ui.caseIndex, cases.length - 1);
    const testcase = cases[ui.caseIndex];
    return `${caseTabs(cases, true)}<div class="case-fields"><label><span class="case-input-label"><span>Input</span><span>One argument per line</span></span><textarea data-field="input" spellcheck="false" placeholder="[2,7,11,15]&#10;9">${esc(testcase.input)}</textarea></label></div><div class="case-note"><span class="muted">Runs on LeetCode</span>${button('deleteCase', 'Remove case', cases.length <= 1 ? 'disabled' : '', 'quiet')}</div>`;
  }

  const formatTime = value => new Date(value).toLocaleString();
  const titleOf = record => record.result?.verdict || (record.local === false && record.status === 'pending' ? ({ fetching: 'Fetching verdict…', judging: 'Judging…', unavailable: 'Verdict unavailable' }[record.verdictState] || 'Fetching verdict…') : ({ sending: 'Sending…', prepared: 'Saving snapshot…', pending: 'Waiting for a result', uncertain: 'Delivery unconfirmed', failed: 'Request failed', reviewed: 'Reviewed in browser' }[record.status] || record.status));
  const colorOf = record => record.result?.passed || record.result?.accepted ? 'good' : record.result ? 'bad' : ['uncertain', 'pending', 'sending'].includes(record.status) ? 'warn' : 'muted';

  function beats(value) {
    const valid = ['number', 'string'].includes(typeof value) && String(value).trim() && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 100;
    return valid ? `Beats ${Number(value).toFixed(2)}%` : 'Beats unavailable';
  }

  function distributionChart(result, metric, width = 320) {
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
    const plotWidth = width - 16;
    const bars = groups.map((share, index) => `<rect class="chart-bar" x="${8 + index * plotWidth / count}" y="${64 - share / peak * 39}" width="${Math.max(1, plotWidth / count - 2)}" height="${share / peak * 39}" rx="1"><title>${esc(units(minimum + index / count * span))}–${esc(units(minimum + (index + 1) / count * span))}: ${share.toFixed(2)}% of submissions</title></rect>`).join('');
    const marker = hasValue ? 8 + (value - minimum) / span * plotWidth : null;
    return `<svg class="distribution-chart" viewBox="0 0 ${width} 88" role="img" aria-label="${label} distribution${hasValue ? `; your result ${esc(units(value))}` : ''}"><title>${label} distribution across LeetCode submissions</title>${bars}${hasValue ? `<line class="chart-marker" x1="${marker}" y1="18" x2="${marker}" y2="66"/><circle class="chart-marker-dot" cx="${marker}" cy="18" r="2.5"/><text class="chart-caption" x="${Math.min(width - 24, Math.max(24, marker))}" y="10" text-anchor="middle">You</text>` : ''}<text class="chart-caption" x="8" y="83">${esc(units(minimum))}</text><text class="chart-caption" x="${width - 8}" y="83" text-anchor="end">${esc(units(maximum))}</text></svg>`;
  }

  const metricCard = (result, metric, label, recordId = '') => `<div class="metric"><div class="metric-heading"><label>${label}</label>${icon(metric === 'runtime' ? 'timer' : 'memory')}</div><div class="value">${esc(result[metric] || 'Not returned')}</div><div class="beats">${beats(result[metric + 'Percentile'])}</div><div data-chart="${metric}" ${recordId ? `data-record="${esc(recordId)}"` : ''}>${distributionChart(result, metric)}</div></div>`;
  function drawCharts() {
    if (!state) return;
    for (const element of app.querySelectorAll('[data-chart]')) {
      const result = element.dataset.record ? state.history.find(record => record.id === element.dataset.record)?.result : state.record?.result;
      const width = element.clientWidth;
      const cached = chartCache.get(element);
      if (result && width && (cached?.width !== width || cached?.result !== result)) {
        chartCache.set(element, { width, result });
        element.innerHTML = distributionChart(result, element.dataset.chart, width);
      }
    }
  }
  function scheduleCharts() {
    if (chartFrame) return;
    chartFrame = requestAnimationFrame(() => { chartFrame = null; drawCharts(); });
  }

  function io(input, actual, failed = false) {
    return `<div class="io"><div><label>Input</label><pre>${esc(input || 'Not provided by LeetCode')}</pre></div><div><label>Your output</label><pre class="${failed ? 'failed' : ''}">${esc(actual ?? 'Not returned')}</pre></div></div>`;
  }

  function resultContent() {
    const r = state.record;
    if (!r) return '<p class="empty">Run tests or submit to see results.</p>';
    const result = r.result;
    let content = `<div class="result-title"><h2 class="${colorOf(r)}">${result ? icon(result.passed || result.accepted ? 'check' : 'cross') : ''}${esc(titleOf(r))}</h2><div class="meta">${result?.totalCases !== null && result?.totalCases !== undefined ? `${esc(result.totalCorrect ?? '—')} / ${esc(result.totalCases)} passed` : r.kind === 'run' ? 'Test run' : 'Submission'}</div>${state.changedSinceRun ? '<small class="warn">Code changed since this attempt</small>' : ''}</div>`;
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
    return `<div class="history-controls"><span class="muted">Submitted solutions</span>${button('loadHistory', icon('refresh') + (page.loading ? 'Loading…' : 'Refresh'), page.loading ? 'disabled' : '', 'quiet')}</div>${page.error ? `<p class="muted" role="status">${esc(page.error)}</p>` : ''}${records.length ? `<table class="history"><thead><tr><th>Verdict</th><th>Language</th><th class="optional">Submitted</th><th>Code</th></tr></thead><tbody>${records.map(r => `<tr><td>${r.result?.accepted ? button('submissionPerformance', esc(titleOf(r)) + icon('chevron'), `data-id="${esc(r.id)}" aria-expanded="${ui.performanceId === r.id}" aria-controls="performance-${esc(r.id)}" title="Show this submission's runtime and memory charts"`, 'good') : button('selectAttempt', esc(titleOf(r)), `data-id="${esc(r.id)}"`, colorOf(r))}</td><td>${esc(r.language)}</td><td class="optional" title="${esc(formatTime(r.createdAt))}">${esc(formatTime(r.createdAt))}</td><td>${button('snapshot', 'View code', `data-id="${esc(r.id)}" title="Open this submission's code"`, 'quiet')}</td></tr>${ui.performanceId === r.id ? `<tr class="history-performance-row"><td colspan="4"><section class="submission-performance" id="performance-${esc(r.id)}" aria-label="Submission runtime and memory" aria-live="polite"><div class="performance-heading"><span>Performance</span>${button('selectAttempt', 'Open result', `data-id="${esc(r.id)}"`, 'quiet')}</div>${ui.performanceLoading ? '<p class="muted performance-status" role="status">Loading comparison data…</p>' : ''}${ui.performanceError ? `<p class="bad performance-status" role="alert">${esc(ui.performanceError)}</p>` : ''}<div class="metrics">${metricCard(r.result || {}, 'runtime', 'Runtime', r.id)}${metricCard(r.result || {}, 'memory', 'Memory', r.id)}</div>${!ui.performanceLoading && !r.result?.runtimeDistribution?.length && !r.result?.memoryDistribution?.length && !ui.performanceError ? '<p class="muted performance-status">LeetCode did not return distribution charts for this submission.</p>' : ''}</section></td></tr>` : ''}`).join('')}</tbody></table>` : !page.loading ? '<p class="empty">No submissions for this problem yet.</p>' : ''}${page.hasNext ? `<div class="load-more">${button('moreHistory', 'Load older submissions', page.loading ? 'disabled' : '')}</div>` : ''}`;
  }

  function results() {
    app.innerHTML = `${tabs()}${ui.tab === 'results' && state.error === state.record?.error ? '' : errorBanner()}<section id="output" role="tabpanel" aria-labelledby="tab-${ui.tab}" class="output" aria-live="polite">${ui.tab === 'cases' ? casesContent() : ui.tab === 'history' ? historyContent() : resultContent()}</section>`;
  }

  function render() {
    const focused = document.activeElement;
    const focusedId = focused?.id, selection = focused?.tagName === 'INPUT' ? [focused.selectionStart, focused.selectionEnd] : null;
    if (mode === 'problems') sidebar(); else if (mode === 'description') description(); else results();
    if (focusedId) { const next = document.getElementById(focusedId); if (next) { next.focus(); if (selection && next.type === 'search') next.setSelectionRange(...selection); } }
    scheduleCharts();
  }
  function saveDraft() {
    if (!state.problem) return;
    drafts.set(state.problem.titleSlug, structuredClone(state.cases));
    send('saveCases', { slug: state.problem.titleSlug, cases: state.cases });
  }

  app.addEventListener('submit', event => { event.preventDefault(); if (event.target.id === 'problem-search') { ui.company = null; ui.groups.all = true; remember(); send('search', { search: document.getElementById('search').value }); } });
  app.addEventListener('input', event => {
    if (event.target.dataset.field) { state.cases[ui.caseIndex][event.target.dataset.field] = event.target.value; saveDraft(); }
  });
  app.addEventListener('toggle', event => {
    if (event.target.dataset.group) ui.groups[event.target.dataset.group] = event.target.open;
    else if (event.target.dataset.disclosure) ui.disclosures[event.target.dataset.disclosure] = event.target.open;
    else return;
    remember();
  }, true);
  app.addEventListener('keydown', event => {
    const tab = event.target.closest('[role="tab"]');
    if (tab && ['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {
      event.preventDefault(); const tabs = [...app.querySelectorAll('[role="tab"]')], current = tabs.indexOf(tab);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
      const key = tabs[index].dataset.tab; tabs[index].click(); app.querySelector(`[data-tab="${key}"]`).focus();
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && mode === 'description' && state.problem && !state.busy) { event.preventDefault(); send(event.shiftKey ? 'submit' : 'run', { slug: state.problem.titleSlug }); }
    if (event.key === 'Escape' && mode === 'problems' && (ui.menuOpen || ui.searchOpen)) { ui.menuOpen = false; ui.searchOpen = false; remember(); render(); }
  });
  app.addEventListener('click', event => {
    const link = event.target.closest('[data-external]');
    if (link) { event.preventDefault(); send('openExternal', { url: link.dataset.external }); return; }
    const target = event.target.closest('button');
    if (!target) return;
    if (target.dataset.slug) { send('openProblem', { slug: target.dataset.slug }); return; }
    if (target.dataset.tab) { ui.tab = target.dataset.tab; remember(); render(); if (ui.tab === 'history') send('loadHistory'); return; }
    if (target.dataset.case !== undefined) { ui.caseIndex = Number(target.dataset.case); remember(); render(); return; }
    const action = target.dataset.action;
    if (action === 'toggleSearch') { ui.searchOpen = !ui.searchOpen; remember(); render(); if (ui.searchOpen) document.getElementById('search').focus(); }
    else if (action === 'toggleMenu') { ui.menuOpen = !ui.menuOpen; render(); }
    else if (['filterDifficulty','filterTag','filterCompany','browse'].includes(action)) {
      const filters = { ...(state.browser.filters || { difficulty: '', tag: null }) };
      ui.groups.all = true; ui.company = null;
      if (action === 'filterDifficulty') filters.difficulty = filters.difficulty === target.dataset.difficulty ? '' : target.dataset.difficulty;
      if (action === 'filterTag') filters.tag = filters.tag?.slug === target.dataset.tag ? null : { slug: target.dataset.tag, name: target.dataset.name };
      if (action === 'filterCompany') { ui.company = { slug: target.dataset.company, name: target.dataset.name }; remember(); render(); return; }
      if (action === 'browse') { filters.difficulty = ''; filters.tag = null; }
      remember(); send('search', { search: action === 'browse' ? '' : state.browser.search, filters });
    }
    else if (['connect','refresh','exit','daily','more','showResults','toggleResults','minimize','clearError','chooseSavePath','settings','loadHistory','moreHistory'].includes(action)) { if (ui.menuOpen) { ui.menuOpen = false; render(); } send(action); }
    else if (action === 'toggleFavorite') send(action, { slug: state.problem.titleSlug });
    else if (action === 'submissionPerformance') {
      ui.performanceId = ui.performanceId === target.dataset.id ? null : target.dataset.id;
      ui.performanceError = null;
      ui.performanceLoading = Boolean(ui.performanceId);
      const request = ++ui.performanceRequest;
      render();
      if (ui.performanceId) send(action, { id: ui.performanceId, request });
    }
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
  new ResizeObserver(scheduleCharts).observe(app);

  window.addEventListener('message', event => {
    if (event.data?.type === 'submissionPerformance') {
      const response = event.data;
      if (response.id !== ui.performanceId || response.request !== ui.performanceRequest || response.slug !== state.problem?.titleSlug || response.owner !== state.connection.username) return;
      ui.performanceLoading = false; ui.performanceError = response.error || null;
      const record = state.history.find(record => record.id === response.id);
      if (record && response.result) record.result = response.result;
      if (ui.tab === 'history') render();
      return;
    }
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
    if (selectedChanged || (state && state.connection.username !== next.connection.username)) { ui.performanceId = null; ui.performanceLoading = false; ui.performanceError = null; }
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
