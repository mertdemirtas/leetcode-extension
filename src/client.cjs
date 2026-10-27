'use strict';

const ORIGIN = 'https://leetcode.com';
const SECRET_KEY = 'leetcode.session.v1';

class ConnectionError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ConnectionError';
    this.code = code;
    this.uncertain = Boolean(options.uncertain);
    this.retryAfter = options.retryAfter;
  }
}

function validateCredentials(value) {
  if (!value || !['session', 'csrf'].every(key => typeof value[key] === 'string' && /^[A-Za-z0-9._~%+\/-]+$/.test(value[key]) && value[key].length <= 16384)) {
    throw new ConnectionError('credentials', 'Enter the cookie values only, without cookie names or headers.');
  }
  return { session: value.session, csrf: value.csrf };
}

function validateSlug(slug) {
  if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 180) throw new Error('Invalid problem slug.');
  return slug;
}

function validateRequestId(value) {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) throw new Error('Invalid judge request ID.');
  if (!['string', 'number'].includes(typeof value) || !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,255}$/.test(String(value))) throw new Error('Invalid judge request ID.');
  return String(value);
}

function questionExtras(question) {
  let stats;
  try { stats = typeof question.companyTagStats === 'string' ? JSON.parse(question.companyTagStats) : question.companyTagStats; }
  catch { /* Company metadata can be absent or unavailable to this account. */ }
  const groups = stats && typeof stats === 'object' ? Object.values(stats).filter(Array.isArray) : [];
  const tags = [...(Array.isArray(question.companyTags) ? question.companyTags : []), ...groups.flat()];
  const companies = new Map();
  for (const tag of tags) {
    if (!tag || typeof tag.name !== 'string' || !tag.name.trim()) continue;
    const name = tag.name.trim();
    const key = name.toLowerCase();
    if (!companies.has(key)) companies.set(key, { name, slug: typeof tag.slug === 'string' ? tag.slug : '' });
  }
  return {
    detailsVersion: 1, hints: Array.isArray(question.hints) ? question.hints.filter(hint => typeof hint === 'string') : [],
    companies: [...companies.values()], companiesAvailable: Array.isArray(question.companyTags) || Boolean(stats && typeof stats === 'object')
  };
}

class LeetCodeClient {
  constructor({ secrets, fetchImpl = globalThis.fetch, timeout = 20000 }) {
    this.secrets = secrets;
    this.fetch = fetchImpl;
    this.timeout = timeout;
  }

  async credentials() {
    const saved = await this.secrets.get(SECRET_KEY);
    if (!saved) throw new ConnectionError('auth', 'Connect your LeetCode account first.');
    try { return validateCredentials(JSON.parse(saved)); }
    catch { throw new ConnectionError('auth', 'Stored credentials could not be read. Connect again.'); }
  }

  async connect(credentials) {
    const safe = validateCredentials(credentials);
    const account = await this.account(safe);
    await this.secrets.store(SECRET_KEY, JSON.stringify(safe));
    return account;
  }

  async disconnect() { await this.secrets.delete(SECRET_KEY); }

  async request(route, { body, credentials, authenticated = true, mutation = false, referer } = {}) {
    const auth = credentials || (authenticated ? await this.credentials() : undefined);
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json', Origin: ORIGIN, Referer: referer || `${ORIGIN}/` };
    if (auth) {
      headers.Cookie = `LEETCODE_SESSION=${auth.session}; csrftoken=${auth.csrf}`;
      headers['X-CSRFToken'] = auth.csrf;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await this.fetch(`${ORIGIN}${route}`, {
        method: body === undefined ? 'GET' : 'POST', headers,
        body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, redirect: 'error'
      });
      if (!response.ok) {
        if (response.status === 401) throw new ConnectionError('auth', 'Your LeetCode session expired. Connect again.');
        if (response.status === 403) throw new ConnectionError('blocked', 'LeetCode refused access. Sign in at leetcode.com, complete any browser verification, then refresh the connection.');
        if (response.status === 429) throw new ConnectionError('rate-limit', 'LeetCode is limiting requests. Wait before trying again.', { retryAfter: response.headers.get('retry-after') });
        throw new ConnectionError('server', `LeetCode returned HTTP ${response.status}.`, { uncertain: mutation && response.status >= 500 });
      }
      const text = await response.text();
      if (text.length > 8_000_000) throw new ConnectionError('protocol', 'The LeetCode response was too large.', { uncertain: mutation });
      let json;
      try { json = JSON.parse(text); }
      catch { throw new ConnectionError('protocol', 'LeetCode returned an unexpected response. Complete browser verification and refresh the connection.', { uncertain: mutation }); }
      if (!json || typeof json !== 'object' || Array.isArray(json)) throw new ConnectionError('protocol', 'LeetCode returned an invalid response.', { uncertain: mutation });
      if (json.error) throw new ConnectionError('rejected', String(json.error).slice(0, 500));
      return json;
    } catch (error) {
      if (error instanceof ConnectionError) throw error;
      throw new ConnectionError('network', 'Could not reach LeetCode. Your saved code and test cases are safe.', { uncertain: mutation });
    } finally { clearTimeout(timer); }
  }

  async graphql(query, variables = {}, options = {}) {
    const response = await this.request('/graphql/', { ...options, body: { query, variables } });
    if (response.errors?.length) throw new ConnectionError('graphql', 'LeetCode could not complete this request. Refresh the connection or try again later.');
    if (!response.data) throw new ConnectionError('protocol', 'LeetCode did not return the requested data.');
    return response.data;
  }

  async account(credentials) {
    const { userStatus } = await this.graphql('query { userStatus { isSignedIn username isPremium } }', {}, { credentials });
    if (!userStatus?.isSignedIn || !userStatus.username) throw new ConnectionError('auth', 'This session is not signed in. Connect with a fresh browser session.');
    return { username: userStatus.username, premium: Boolean(userStatus.isPremium) };
  }

  async list({ search = '', skip = 0, limit = 25 } = {}) {
    const saved = await this.secrets.get(SECRET_KEY);
    const data = await this.graphql(`query problemsetQuestionList($skip: Int, $limit: Int, $filters: QuestionListFilterInput) {
      problemsetQuestionList: questionList(categorySlug: "", skip: $skip, limit: $limit, filters: $filters) {
        total: totalNum questions: data { questionFrontendId title titleSlug difficulty isPaidOnly status }
      }
    }`, { skip, limit, filters: search.trim() ? { searchKeywords: search.trim() } : {} }, { authenticated: Boolean(saved) });
    const list = data.problemsetQuestionList;
    if (!Array.isArray(list?.questions) || !Number.isFinite(list.total)) throw new ConnectionError('protocol', 'The problem list format has changed.');
    return { total: list.total, questions: list.questions.map(q => ({ ...q, titleSlug: validateSlug(q.titleSlug) })) };
  }

  async problem(slug) {
    validateSlug(slug);
    const saved = await this.secrets.get(SECRET_KEY);
    const { question } = await this.graphql(`query questionData($titleSlug: String!) {
      question(titleSlug: $titleSlug) { questionId questionFrontendId title titleSlug difficulty isPaidOnly content
        exampleTestcases sampleTestCase metaData codeSnippets { lang langSlug code } topicTags { name slug }
        hints companyTags { name slug } companyTagStats }
    }`, { titleSlug: slug }, { authenticated: Boolean(saved), referer: `${ORIGIN}/problems/${slug}/` });
    if (!question?.questionId || !Array.isArray(question.codeSnippets)) throw new ConnectionError('unavailable', 'This problem is unavailable for this account or does not support code submissions.');
    if (!question.content) throw new ConnectionError('premium', 'The description is unavailable. This problem may require LeetCode Premium.');
    return { ...question, titleSlug: validateSlug(question.titleSlug), ...questionExtras(question) };
  }

  async daily() {
    const { activeDailyCodingChallengeQuestion } = await this.graphql('query { activeDailyCodingChallengeQuestion { question { titleSlug } } }', {}, { authenticated: false });
    return validateSlug(activeDailyCodingChallengeQuestion?.question?.titleSlug);
  }

  async start(kind, { problem, language, code, input }) {
    validateSlug(problem.titleSlug);
    if (!['run', 'submit'].includes(kind) || !problem.questionId || !/^[a-z0-9]+$/.test(language) || !code.trim()) throw new Error('A problem, language, and nonempty solution are required.');
    const body = { lang: language, question_id: String(problem.questionId), typed_code: code };
    if (kind === 'run') body.data_input = input;
    const response = await this.request(`/problems/${problem.titleSlug}/${kind === 'run' ? 'interpret_solution' : 'submit'}/`, { body, mutation: true, referer: `${ORIGIN}/problems/${problem.titleSlug}/` });
    const id = kind === 'run' ? response.interpret_id : response.submission_id;
    try { return validateRequestId(id); }
    catch {
      const missing = id === undefined || id === null || id === '';
      const advice = kind === 'run' ? 'You can start a new test run manually.' : 'Check your submission history before retrying.';
      throw new ConnectionError('protocol', `LeetCode ${missing ? 'did not return a request ID' : 'returned an unsupported request ID'}. ${advice}`, { uncertain: true });
    }
  }

  async check(id) {
    return this.request(`/submissions/detail/${validateRequestId(id)}/check/`);
  }
}

module.exports = { LeetCodeClient, ConnectionError, SECRET_KEY, ORIGIN, validateCredentials, validateSlug, validateRequestId };
