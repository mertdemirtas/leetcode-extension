'use strict';

const vscode = require('vscode');
const { randomBytes, createHash } = require('node:crypto');
const { LeetCodeClient, ORIGIN, SECRET_KEY, validateSlug } = require('./client.cjs');
const { Journal } = require('./journal.cjs');
const { Judge, exampleCases, validateCases } = require('./judge.cjs');
const { prepareFiles } = require('./files.cjs');
const { BrowserSignIn } = require('./auth.cjs');
const { EXTENSIONS } = require('./languages.cjs');
const { submissionRecord, submissionResult, mergeSubmissions } = require('./submissions.cjs');

const PREFIX = 'singularityLeetcode';
const esc = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hash = code => createHash('sha256').update(code).digest('hex').slice(0, 12);

function html(webview, context, mode) {
  const nonce = randomBytes(24).toString('base64');
  const resource = filename => webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', filename));
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https://assets.leetcode.com https://leetcode.com data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; connect-src 'none'; base-uri 'none'; form-action 'none';">
    <link rel="stylesheet" href="${esc(resource('main.css'))}"><title>LeetCode</title></head>
    <body data-mode="${mode}"><main id="app"><p class="empty">Loading LeetCode…</p></main><script nonce="${nonce}" src="${esc(resource('main.js'))}"></script></body></html>`;
}

class Controller {
  constructor(context, journal) {
    this.context = context;
    this.journal = journal;
    this.saved = context.workspaceState.get('state.v1') || { documents: {}, problems: {}, cases: {}, selected: null, language: null, activeUri: null, recent: [] };
    delete this.saved.directories;
    this.saved.favorites ||= [];
    this.client = new LeetCodeClient({ secrets: context.secrets, timeout: this.config('requestTimeout', 20000) });
    this.connection = { status: 'disconnected', username: null, error: null };
    this.browser = { questions: [], total: 0, search: '', filters: { difficulty: '', tag: null }, loading: false, error: null };
    this.views = new Map();
    this.displayed = null;
    this.currentHash = null;
    this.searchGeneration = 0;
    this.authVersion = 0;
    this.connecting = false;
    this.saveQueue = Promise.resolve();
    this.panelQueue = Promise.resolve();
    this.submissions = { records: [] };
    this.historyGeneration = 0;
    this.detailRequests = new Map();
    this.judge = new Judge({ client: this.client, journal, changed: record => {
      this.displayed = record.id; this.publish();
      if (record.kind === 'submit' && record.status === 'complete') void this.enrichSubmission(record).catch(() => {});
    } });
  }

  config(key, fallback) { return vscode.workspace.getConfiguration('singularityLeetcode').get(key, fallback); }
  problem() { return this.saved.problems[this.saved.selected]; }

  persist() {
    const snapshot = structuredClone(this.saved);
    const operation = this.saveQueue.then(() => this.context.workspaceState.update('state.v1', snapshot));
    this.saveQueue = operation.catch(() => {});
    return operation;
  }

  state() {
    const problem = this.problem();
    const history = this.journal.list().filter(r => r.slug === this.saved.selected && (!this.connection.username || r.owner === this.connection.username));
    const selectedRecord = this.recordById(this.displayed);
    const record = selectedRecord?.slug === this.saved.selected && (!this.connection.username || selectedRecord.owner === this.connection.username) ? selectedRecord : history[0];
    const summary = record => {
      if (!record) return null;
      const { code, cases, result, ...rest } = record;
      return { ...rest, result: result ? { ...result, raw: undefined } : undefined };
    };
    return {
      connection: this.connection, browser: this.browser, problem: problem ? { ...problem, codeSnippets: problem.codeSnippets.map(s => ({ lang: s.lang, langSlug: s.langSlug })) } : null,
      language: this.saved.language, cases: this.saved.cases[this.saved.selected] || [],
      history: mergeSubmissions(history, this.remoteHistory()).map(summary),
      submissionHistory: this.submissions.slug === this.saved.selected && this.submissions.owner === this.connection.username ? { loading: this.submissions.loading, error: this.submissions.error, hasNext: this.submissions.hasNext } : {},
      record: summary(record), busy: this.judge.busy || Boolean(this.executing) || this.connecting || Boolean(this.restoring), connectionBusy: this.connecting || Boolean(this.restoring), authorizing: Boolean(this.browserAuth?.pending),
      changedSinceRun: Boolean(record?.snapshot && this.currentHash && record.snapshot !== this.currentHash),
      resultsVisible: Boolean(this.views.get('results')?.visible),
      favorites: this.saved.favorites,
      knownProblems: Object.values(this.saved.problems).map(p => ({ titleSlug: p.titleSlug, title: p.title, questionFrontendId: p.questionFrontendId, difficulty: p.difficulty, topicTags: p.topicTags || [], companies: p.companies || [], isPaidOnly: p.isPaidOnly })),
      recent: this.saved.recent.map(slug => this.saved.problems[slug]).filter(Boolean).map(p => ({ titleSlug: p.titleSlug, title: p.title, questionFrontendId: p.questionFrontendId, difficulty: p.difficulty })),
      error: this.error || null
    };
  }

  publish() { const state = this.state(); for (const view of this.views.values()) void view.webview.postMessage({ type: 'state', state }); }

  remoteHistory() { return this.submissions.slug === this.saved.selected && this.submissions.owner === this.connection.username ? this.submissions.records : []; }
  recordById(id) { return this.journal.get(id) || this.remoteHistory().find(record => record.id === id); }

  async loadHistory(append = false) {
    const slug = this.saved.selected, owner = this.connection.username, authVersion = this.authVersion;
    if (!slug) return;
    const current = this.submissions.slug === slug && this.submissions.owner === owner ? this.submissions : { slug, owner, records: [], offset: 0, lastKey: null };
    if (current.loading || (append && !current.hasNext)) return;
    const generation = ++this.historyGeneration;
    this.submissions = { ...current, loading: true, error: null }; this.publish();
    const active = () => generation === this.historyGeneration && authVersion === this.authVersion && slug === this.saved.selected && owner === this.connection.username;
    try {
      if (!owner || this.connection.status !== 'connected') throw new Error('Connect or refresh your account to load LeetCode submissions.');
      const page = await this.client.submissions(slug, { offset: append ? current.offset : 0, lastKey: append ? current.lastKey : null });
      if (!active()) return;
      const records = page.submissions.map(item => submissionRecord(item, owner));
      let next = 0;
      const unresolved = records.filter(record => record.status === 'pending');
      await Promise.all(Array.from({ length: Math.min(4, unresolved.length) }, async () => {
        while (next < unresolved.length && active()) {
          const record = unresolved[next++];
          try {
            const details = await this.client.submissionStatus(record.remoteId);
            if (!active()) return;
            if (details.user.username !== owner || details.question.titleSlug !== slug) throw new Error('Submission account or problem mismatch.');
            if (details.statusCode >= 10) Object.assign(record, { status: 'complete', result: submissionResult(details), verdictState: undefined });
            else record.verdictState = 'judging';
          } catch { record.verdictState = 'unavailable'; }
        }
      }));
      if (!active()) return;
      const finished = new Map(records.filter(record => record.status === 'complete').map(record => [record.remoteId, record]));
      for (const local of this.journal.list()) {
        if (!active()) return;
        const remote = finished.get(local.remoteId);
        if (remote && local.kind === 'submit' && local.owner === owner && local.slug === slug && (local.status !== 'complete' || local.result?.verdict !== remote.result?.verdict)) {
          await this.journal.update(local.id, { status: 'complete', result: remote.result, error: null, detailsLoaded: false });
        }
      }
      if (!active()) return;
      this.submissions = { slug, owner, records: mergeSubmissions(append ? current.records : [], records), offset: (append ? current.offset : 0) + records.length, lastKey: page.lastKey, hasNext: page.hasNext, loading: false, error: null };
    } catch (error) {
      if (active()) this.submissions = { ...this.submissions, loading: false, error: error.message };
    } finally {
      if (generation === this.historyGeneration && this.submissions.slug === slug && this.submissions.owner === owner) this.submissions.loading = false;
      if (active()) this.publish();
    }
  }

  async enrichSubmission(record) {
    if (!record || record.kind !== 'submit' || !/^[1-9]\d*$/.test(record.remoteId || '') || record.detailsLoaded || this.connection.status !== 'connected') return record;
    const owner = this.connection.username, authVersion = this.authVersion;
    if (record.owner !== owner) throw new Error('Connect the account that submitted this code.');
    const key = `${authVersion}:${owner}:${record.remoteId}`;
    if (this.detailRequests.has(key)) return this.detailRequests.get(key);
    const operation = (async () => {
      const details = await this.client.submissionDetails(record.remoteId);
      if (authVersion !== this.authVersion || owner !== this.connection.username) throw new Error('The connected account changed. Select the submission again.');
      if (details.user.username !== owner || details.question.titleSlug !== record.slug) throw new Error('This submission belongs to a different account or problem.');
      if (!Number.isInteger(Number(details.statusCode)) || Number(details.statusCode) < 10) return record;
      const current = this.journal.get(record.id) || record;
      const result = submissionResult(details);
      for (const name of ['runtimePercentile', 'memoryPercentile']) result[name] ??= current.result?.[name] ?? null;
      for (const name of ['runtimeDistribution', 'memoryDistribution']) if (!result[name].length) result[name] = current.result?.[name] || [];
      const fields = { status: 'complete', detailsLoaded: true, result };
      let updated;
      if (this.journal.get(record.id)) updated = await this.journal.update(record.id, fields);
      else {
        updated = { ...record, ...fields, code: details.code, snapshot: hash(details.code) };
        if (this.submissions.owner === owner && this.submissions.slug === record.slug) this.submissions.records = this.submissions.records.map(item => item.id === record.id ? updated : item);
      }
      this.publish();
      return updated;
    })();
    this.detailRequests.set(key, operation);
    try { return await operation; } finally { this.detailRequests.delete(key); }
  }

  report(error, notify = true) {
    this.error = error.message || 'The operation could not be completed.';
    if (['auth', 'blocked', 'network', 'rate-limit'].includes(error.code)) this.connection = { ...this.connection, status: error.code, error: this.error };
    this.publish();
    if (notify) void vscode.window.showErrorMessage(`LeetCode: ${this.error}`);
  }

  async restore() {
    this.restoring = true;
    this.connection = { status: 'restoring', username: null, error: null }; this.publish();
    try {
      if (await this.context.secrets.get(SECRET_KEY)) {
        await this.refresh(false);
        if (this.connection.status === 'connected') await this.search(this.browser.search);
      } else this.connection = { status: 'disconnected', username: null, error: null };
    } finally { this.restoring = false; this.publish(); }
  }

  async connect() {
    if (this.judge.busy || this.executing || this.connecting || this.restoring) throw new Error('Wait for the current connection or judge request before changing accounts.');
    this.connecting = true; this.authVersion++; this.publish();
    try { return await this.performConnect(); }
    finally { this.connecting = false; this.publish(); }
  }

  async performConnect() {
    const method = await vscode.window.showQuickPick([
      { label: 'Open LeetCode sign-in', description: 'Sign in, authorize, and return to this IDE automatically', method: 'browser' },
      { label: 'Connect with browser session', description: 'Enter LEETCODE_SESSION and csrftoken securely', method: 'manual' }
    ], { title: 'Connect to LeetCode', ignoreFocusOut: true });
    if (!method) return;
    let credentials;
    if (method.method === 'browser') credentials = await this.browserSignIn();
    else {
      const session = await vscode.window.showInputBox({ title: 'LeetCode session', prompt: 'In your signed-in browser: Developer Tools → Application/Storage → Cookies → leetcode.com → LEETCODE_SESSION. Paste only its value.', password: true, ignoreFocusOut: true });
      if (!session) return;
      const csrf = await vscode.window.showInputBox({ title: 'LeetCode CSRF token', prompt: 'From the same browser session, paste the csrftoken cookie value. Credentials are stored only in the IDE secret store.', password: true, ignoreFocusOut: true });
      if (!csrf) return;
      credentials = { session: session.trim(), csrf: csrf.trim() };
    }
    if (!credentials) return;
    this.publish();
    const account = await this.client.connect(credentials);
    this.connection = { status: 'connected', ...account, error: null }; this.error = null;
    this.publish();
    await this.search(this.browser.search);
  }

  async browserSignIn() {
    this.browserAuth?.dispose();
    const auth = new BrowserSignIn({
      scheme: vscode.env.uriScheme || (/insiders/i.test(vscode.env.appName) ? 'vscode-insiders' : 'vscode'),
      authority: this.context.extension?.id || 'mertdemirtas.singularity-leetcode',
      // Singularity's browser-based Theia host has no operating-system URI dispatcher.
      loopback: /singularity|theia/i.test(vscode.env.appName)
    });
    this.browserAuth = auth;
    this.error = null; this.publish();
    try {
      const url = await auth.begin();
      if (!url) return null;
      if (await this.openSignInUrl(url) === false) throw new Error('The browser could not be opened. Select Connect and try again, or use Connect with browser session.');
      return await auth.result;
    } finally { auth.cancel(); this.publish(); }
  }

  openSignInUrl(url) { return vscode.env.openExternal(vscode.Uri.parse(url)); }

  async refresh(notify = true) {
    if (this.connecting) throw new Error('Wait for the connection setup to finish.');
    const authVersion = this.authVersion;
    this.client.timeout = this.config('requestTimeout', 20000);
    try {
      const account = await this.client.account();
      if (authVersion !== this.authVersion) return;
      this.connection = { status: 'connected', ...account, error: null }; this.error = null;
      this.publish();
      const pending = this.journal.list().find(r => r.owner === account.username && r.remoteId && r.status === 'pending');
      if (pending && !this.judge.busy) await this.judge.resume(pending.id, account.username);
    } catch (error) { if (authVersion === this.authVersion) this.report(error, notify); }
    finally { this.publish(); }
  }

  async exit() {
    if (this.connecting && !this.browserAuth?.pending) throw new Error('Wait for connection validation to finish before signing out.');
    this.browserAuth?.cancel();
    this.authVersion++;
    this.historyGeneration++;
    this.submissions = { records: [] };
    this.judge.cancel();
    await this.client.disconnect();
    this.connection = { status: 'disconnected', username: null, error: null }; this.error = null;
    await this.minimize();
    this.description?.dispose();
    this.publish();
  }

  async search(search = '', append = false, filters = this.browser.filters || { difficulty: '', tag: null }) {
    if (typeof search !== 'string' || search.length > 150) throw new Error('Search text is too long.');
    if (!filters || !['', 'Easy', 'Medium', 'Hard'].includes(filters.difficulty || '') || (filters.tag !== null && filters.tag !== undefined && (typeof filters.tag.name !== 'string' || filters.tag.name.length > 100))) throw new Error('Invalid problem filters.');
    if (filters.tag) validateSlug(filters.tag.slug);
    filters = { difficulty: filters.difficulty || '', tag: filters.tag ? { name: filters.tag.name, slug: filters.tag.slug } : null };
    const generation = ++this.searchGeneration;
    const skip = append ? this.browser.questions.length : 0;
    this.browser = { ...this.browser, search, filters, loading: true, error: null };
    this.publish();
    try {
      const page = await this.client.list({ search, skip, difficulty: filters.difficulty, tag: filters.tag?.slug || null });
      if (generation !== this.searchGeneration) return;
      this.browser = { questions: append ? [...this.browser.questions, ...page.questions] : page.questions, total: page.total, search, filters, loading: false, error: null };
    } catch (error) {
      if (generation === this.searchGeneration) this.browser = { ...this.browser, loading: false, error: error.message };
      throw error;
    } finally { this.publish(); }
  }

  async openProblem(slug, language) {
    validateSlug(slug);
    if (this.opening) throw new Error('A problem is already opening.');
    this.opening = true;
    try {
      let problem = this.saved.problems[slug];
      if (problem?.detailsVersion !== 1) {
        try { problem = await this.client.problem(slug); }
        catch (error) { if (!problem) throw error; this.report(error, false); }
      }
      const preferred = language || this.config('defaultLanguage', 'python3');
      let snippet = problem.codeSnippets.find(s => s.langSlug === preferred);
      if (!snippet) {
        const choice = await vscode.window.showQuickPick(problem.codeSnippets.map(s => ({ label: s.lang, slug: s.langSlug })), { title: `Language for ${problem.title}` });
        if (!choice) return;
        snippet = problem.codeSnippets.find(s => s.langSlug === choice.slug);
      }
      if (!Object.hasOwn(EXTENSIONS, snippet.langSlug)) throw new Error('This language is not yet supported for local solution files. Choose another language.');
      let folder = vscode.workspace.workspaceFolders?.[0];
      if (vscode.workspace.workspaceFolders?.length > 1) folder = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Choose the workspace for LeetCode solutions' });
      const previous = Object.entries(this.saved.documents).reverse().find(([_uri, mapped]) => mapped.slug === slug && mapped.language === snippet.langSlug);
      const previousUri = previous && vscode.Uri.parse(previous[0]);
      const previousDocument = previous && vscode.workspace.textDocuments?.find(document => document.uri.toString() === previous[0]);
      if (previousDocument?.isDirty && !await previousDocument.save()) throw new Error('Save the existing solution before opening it in the new location.');
      const files = await prepareFiles({ savePath: this.config('savePath', ''), workspace: folder?.uri.scheme === 'file' ? folder.uri.fsPath : undefined, problem,
        language: snippet.langSlug, extension: EXTENSIONS[snippet.langSlug], starter: snippet.code, defaultCases: exampleCases(problem), savedCases: this.saved.cases[slug],
        legacySolution: previousUri?.scheme === 'file' ? previousUri.fsPath : undefined });
      const uri = vscode.Uri.file(files.solution);
      this.saved.problems[slug] = problem;
      this.saved.cases[slug] = files.cases;
      this.saved.selected = slug; this.saved.language = snippet.langSlug; this.saved.activeUri = uri.toString();
      this.saved.documents[uri.toString()] = { slug, language: snippet.langSlug };
      this.saved.recent = [slug, ...this.saved.recent.filter(s => s !== slug)].slice(0, 20);
      this.displayed = null;
      await this.persist();
      const document = await vscode.workspace.openTextDocument(uri);
      this.currentHash = hash(document.getText());
      await vscode.commands.executeCommand('setContext', `${PREFIX}.solutionActive`, true);
      await this.showDescription();
      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Two, preview: false });
      await this.showResults(false);
      this.publish();
    } finally { this.opening = false; }
  }

  async selectLanguage() {
    const problem = this.problem();
    if (!problem) throw new Error('Open a LeetCode problem before choosing its language.');
    if (this.judge.busy || this.executing || this.opening) throw new Error('Wait for the current request before changing languages.');
    const choice = await vscode.window.showQuickPick(problem.codeSnippets.map(snippet => ({ label: snippet.lang, description: snippet.langSlug === this.saved.language ? 'Current language' : '', slug: snippet.langSlug })), { title: `Language for ${problem.title}`, placeHolder: 'Choose a language supported by this problem' });
    if (!choice || choice.slug === this.saved.language) return;
    if (this.saved.selected !== problem.titleSlug) throw new Error('The selected problem changed. Choose its language again.');
    await this.openProblem(problem.titleSlug, choice.slug);
  }

  async showDescription() {
    const ownHost = /singularity|theia/i.test(vscode.env.appName);
    const created = !this.description;
    if (!this.description) {
      if (ownHost) {
        let resolve;
        this.descriptionReady = { promise: new Promise(done => { resolve = done; }), resolve: () => resolve() };
      }
      this.description = vscode.window.createWebviewPanel(`${PREFIX}.description`, 'LeetCode problem', { viewColumn: vscode.ViewColumn.One, preserveFocus: true }, { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')], retainContextWhenHidden: true });
      this.attach('description', this.description);
      this.description.onDidDispose(() => { this.description = null; this.views.delete('description'); });
    }
    this.description.title = `${this.problem().questionFrontendId}. ${this.problem().title}`;
    // Creation already reveals the panel. Theia can try to reattach a visible
    // panel to itself if its first column is passed to reveal() again.
    if (!created) this.description.reveal(ownHost ? undefined : vscode.ViewColumn.One, true);
    if (ownHost && this.descriptionReady) {
      let timer;
      try {
        await Promise.race([this.descriptionReady.promise, new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('The problem description could not open. Try opening the problem again.')), 15000);
        })]);
      } finally { clearTimeout(timer); }
    }
  }

  attach(mode, view) {
    this.views.set(mode, view);
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    view.webview.html = html(view.webview, this.context, mode);
    const subscription = view.webview.onDidReceiveMessage(message => {
      if (mode === 'description' && message?.type === 'ready') this.descriptionReady?.resolve();
      void this.message(message).catch(error => this.report(error));
    });
    this.context.subscriptions.push(subscription);
    if (mode === 'results' && view.onDidChangeVisibility) this.context.subscriptions.push(view.onDidChangeVisibility(() => this.publish()));
    if (view.onDidDispose) this.context.subscriptions.push(view.onDidDispose(() => { if (this.views.get(mode) === view) this.views.delete(mode); }));
  }

  async showResults(focus = true) {
    await vscode.commands.executeCommand('setContext', `${PREFIX}.resultsVisible`, true);
    await vscode.commands.executeCommand(`${PREFIX}.results.focus`, { preserveFocus: !focus });
    this.publish();
    void this.enrichSubmission(this.recordById(this.state().record?.id)).catch(() => {});
  }

  toggleResults() {
    const operation = this.panelQueue.then(() => this.views.get('results')?.visible ? this.minimize() : this.showResults());
    this.panelQueue = operation.catch(() => {});
    return operation;
  }

  async minimize() {
    const commands = await vscode.commands.getCommands(true);
    if (commands.includes('workbench.action.closePanel')) await vscode.commands.executeCommand('workbench.action.closePanel');
    else {
      const toggle = 'plugin.view-container.workbench.view.extension.singularity-leetcode-results.toggle';
      if (commands.includes(toggle) && this.views.get('results')?.visible) await vscode.commands.executeCommand(toggle);
    }
    await vscode.commands.executeCommand('setContext', `${PREFIX}.resultsVisible`, false);
    this.publish();
  }

  async updateCases(slug, cases, strict = false) {
    validateSlug(slug);
    if (!this.saved.problems[slug]) throw new Error('Open this problem before saving test cases.');
    if (!Array.isArray(cases) || !cases.length || cases.length > 50 || JSON.stringify(cases).length > 200000 || cases.some(c => !c || typeof c.input !== 'string')) throw new Error('Invalid test cases.');
    this.saved.cases[slug] = strict ? validateCases(cases) : cases.map((c, i) => ({ input: c.input, name: String(c.name || `Case ${i + 1}`).slice(0, 80) }));
    const snapshot = structuredClone(this.saved.cases[slug]);
    await this.persist();
    for (const view of this.views.values()) void view.webview.postMessage({ type: 'casesSaved', slug, cases: snapshot });
  }

  async chooseSavePath() {
    const chosen = await vscode.window.showOpenDialog({ title: 'LeetCode problem save folder', canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Save problems here' });
    if (!chosen?.[0]) return;
    if (chosen[0].scheme !== 'file') throw new Error('Choose a local folder for LeetCode problems.');
    await vscode.workspace.getConfiguration('singularityLeetcode').update('savePath', chosen[0].fsPath, vscode.ConfigurationTarget.Global);
  }

  async execute(kind, suppliedCases, slug) {
    if (this.executing) throw new Error('A judge request is already active.');
    this.executing = true;
    try { return await this.performExecute(kind, suppliedCases, slug); }
    finally { this.executing = false; this.publish(); }
  }

  async performExecute(kind, suppliedCases, slug) {
    if (this.connecting) throw new Error('Wait for connection setup to finish before running code.');
    if (this.connection.status !== 'connected') throw new Error('Use Connect or Refresh connection before running code.');
    if (this.judge.busy) throw new Error('A judge request is already active.');
    if (!this.saved.activeUri || !this.problem()) throw new Error('Open a LeetCode solution first.');
    if (slug && slug !== this.saved.selected) throw new Error('The selected problem changed. Review the current solution and try again.');
    const problem = this.problem(), language = this.saved.language, fileUri = this.saved.activeUri, owner = this.connection.username;
    const cases = structuredClone(suppliedCases || this.saved.cases[problem.titleSlug] || []);
    if (suppliedCases) await this.updateCases(problem.titleSlug, cases, kind === 'run');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(fileUri));
    if (!await document.save()) throw new Error('Save the solution successfully before running or submitting.');
    const code = document.getText();
    if (code.length > 1_000_000) throw new Error('The solution is too large (maximum 1 MB).');
    this.currentHash = hash(code); this.error = null;
    await this.showResults();
    try {
      await this.judge.execute({ kind, problem, language, code, cases, owner, fileUri });
    } finally { this.publish(); }
  }

  async editorChanged(editor) {
    // A webview or panel taking focus does not replace the selected solution.
    if (!editor) return;
    const uri = editor?.document.uri.toString();
    const mapped = uri && this.saved.documents[uri];
    await vscode.commands.executeCommand('setContext', `${PREFIX}.solutionActive`, Boolean(mapped));
    if (mapped && this.saved.problems[mapped.slug]) {
      this.saved.selected = mapped.slug; this.saved.language = mapped.language; this.saved.activeUri = uri;
      this.currentHash = hash(editor.document.getText());
      this.displayed = null;
      await this.persist();
      if (this.description) this.description.title = `${this.problem().questionFrontendId}. ${this.problem().title}`;
      this.publish();
    }
  }

  async message(message) {
    if (!message || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'ready': this.publish(); break;
      case 'connect': await this.connect(); break;
      case 'refresh': await this.refresh(); break;
      case 'exit': await this.exit(); break;
      case 'chooseSavePath': await this.chooseSavePath(); break;
      case 'settings': await vscode.commands.executeCommand('workbench.action.openSettings', 'singularityLeetcode'); break;
      case 'toggleFavorite': {
        validateSlug(message.slug);
        if (!this.saved.problems[message.slug]) throw new Error('Open the problem before saving it as a favorite.');
        this.saved.favorites = this.saved.favorites.includes(message.slug) ? this.saved.favorites.filter(slug => slug !== message.slug) : [...this.saved.favorites, message.slug];
        await this.persist(); this.publish(); break;
      }
      case 'search': await this.search(message.search, false, message.filters || this.browser.filters); break;
      case 'more': await this.search(this.browser.search, true); break;
      case 'daily': await this.openProblem(await this.client.daily()); break;
      case 'openProblem': await this.openProblem(message.slug, message.language); break;
      case 'run': case 'submit': await this.execute(message.type, message.cases, message.slug); break;
      case 'saveCases': await this.updateCases(message.slug, message.cases); break;
      case 'showResults': await this.showResults(); break;
      case 'toggleResults': case 'minimize': await this.toggleResults(); break;
      case 'loadHistory': await this.loadHistory(); break;
      case 'moreHistory': await this.loadHistory(true); break;
      case 'submissionPerformance': {
        const slug = this.saved.selected, owner = this.connection.username, authVersion = this.authVersion;
        const response = { type: 'submissionPerformance', id: message.id, request: message.request, slug, owner };
        try {
          const record = this.recordById(message.id);
          if (!record || record.kind !== 'submit' || record.slug !== slug || record.owner !== owner || !record.result?.accepted) throw new Error('Choose an accepted submission from the connected account.');
          const updated = await this.enrichSubmission(record);
          if (!updated?.result?.accepted) throw new Error(`This submission is now ${updated?.result?.verdict || 'unavailable'}. Refresh submissions to update its verdict.`);
          response.result = { ...updated.result, raw: undefined };
        } catch (error) { response.error = error.message || 'Submission performance is unavailable.'; }
        if (authVersion === this.authVersion && slug === this.saved.selected && owner === this.connection.username) await this.views.get('results')?.webview.postMessage(response);
        break;
      }
      case 'selectAttempt': {
        const record = this.recordById(message.id);
        if (!record || record.slug !== this.saved.selected || (this.connection.username && record.owner !== this.connection.username)) throw new Error('This submission belongs to a different account or problem.');
        this.displayed = message.id; this.publish();
        await this.enrichSubmission(record); break;
      }
      case 'resume':
        try {
          if (this.journal.get(message.id)) await this.judge.resume(message.id, this.connection.username);
          else await this.enrichSubmission(this.recordById(message.id));
        }
        finally { this.publish(); }
        break;
      case 'snapshot': {
        let record = this.recordById(message.id);
        if (!record || record.slug !== this.saved.selected || (this.connection.username && record.owner !== this.connection.username)) throw new Error('This submission belongs to a different account or problem.');
        if (typeof record.code !== 'string') record = await this.enrichSubmission(record);
        if (typeof record?.code !== 'string') throw new Error('Connect or refresh your account to retrieve the submitted code.');
        if (record.slug !== this.saved.selected) throw new Error('The selected problem changed. Select the submission again.');
        const document = await vscode.workspace.openTextDocument({ content: record.code, language: ['python3', 'pythondata'].includes(record.language) ? 'python' : record.language === 'golang' ? 'go' : record.language === 'react' ? 'javascriptreact' : record.language === 'vanillajs' ? 'javascript' : record.language });
        await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Two, preview: false }); break;
      }
      case 'markReviewed': {
        const record = this.journal.get(message.id);
        if (this.judge.busy || record?.owner !== this.connection.username) throw new Error('Connect the original account and wait for the active request before reviewing this attempt.');
        if (!record || !['uncertain', 'pending'].includes(record.status)) throw new Error('This attempt is not unresolved.');
        await this.journal.update(record.id, { status: 'reviewed', error: 'Marked reviewed by the user after checking LeetCode history.' });
        this.publish(); break;
      }
      case 'openExternal': {
        const url = new URL(message.url);
        if (url.origin !== ORIGIN || url.username || url.password) throw new Error('Only LeetCode links can be opened from this panel.');
        await vscode.env.openExternal(vscode.Uri.parse(url.href)); break;
      }
      case 'clearError': this.error = null; this.publish(); break;
    }
  }

  dispose() { this.browserAuth?.dispose(); this.judge.cancel(); this.description?.dispose(); }
}

async function activate(context) {
  if (!context.secrets) throw new Error('This IDE does not provide secure extension secret storage.');
  const journal = new Journal(context.globalStorageUri.fsPath);
  await journal.load();
  const controller = new Controller(context, journal);
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri: uri => controller.browserAuth?.handleUri(uri) }));
  const command = (name, action) => context.subscriptions.push(vscode.commands.registerCommand(`${PREFIX}.${name}`, (...args) => Promise.resolve().then(() => action(...args)).catch(error => controller.report(error))));
  command('open', () => vscode.commands.executeCommand(`${PREFIX}.problems.focus`));
  command('connect', () => controller.connect()); command('refresh', () => controller.refresh()); command('exit', () => controller.exit());
  command('chooseSavePath', () => controller.chooseSavePath());
  command('run', () => controller.execute('run')); command('submit', () => controller.execute('submit'));
  command('selectLanguage', () => controller.selectLanguage());
  command('showResults', () => controller.showResults());
  command('toggleResults', () => controller.toggleResults()); command('minimizeResults', () => controller.toggleResults());
  for (const mode of ['problems', 'results']) context.subscriptions.push(vscode.window.registerWebviewViewProvider(`${PREFIX}.${mode}`, { resolveWebviewView: view => controller.attach(mode, view) }, { webviewOptions: { retainContextWhenHidden: true } }));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => { void controller.editorChanged(editor).catch(error => controller.report(error)); }));
  let timer;
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
    if (event.document.uri.toString() !== controller.saved.activeUri) return;
    clearTimeout(timer); timer = setTimeout(() => { controller.currentHash = hash(event.document.getText()); controller.publish(); }, 150);
  }));
  context.subscriptions.push({ dispose: () => { clearTimeout(timer); controller.dispose(); } });
  await vscode.commands.executeCommand('setContext', `${PREFIX}.resultsVisible`, false);
  await controller.editorChanged(vscode.window.activeTextEditor);
  void controller.restore().catch(error => controller.report(error, false));
  return { status: 'ready' };
}

module.exports = { activate, Controller, html };
