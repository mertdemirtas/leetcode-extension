'use strict';

const { createHash } = require('node:crypto');

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

function validateSubmissionId(value) {
  const id = validateRequestId(value);
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error('Invalid submission ID.');
  return id;
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
    this.companyPages = new Map();
    this.companyOwner = null;
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
    this.companyPages.clear();
    return account;
  }

  async disconnect() { this.companyOwner = null; this.companyPages.clear(); await this.secrets.delete(SECRET_KEY); }

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

  async list({ search = '', skip = 0, limit = 25, difficulty = '', tag = null, company = null } = {}) {
    if (typeof search !== 'string' || search.length > 150 || !Number.isSafeInteger(skip) || skip < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid problem search.');
    if (!['', 'Easy', 'Medium', 'Hard'].includes(difficulty)) throw new Error('Invalid problem difficulty.');
    if (tag !== null) validateSlug(tag);
    if (company !== null) {
      validateSlug(company);
      const saved = await this.secrets.get(SECRET_KEY);
      const owner = saved ? createHash('sha256').update(saved).digest('hex') : null;
      if (this.companyOwner !== owner) { this.companyPages.clear(); this.companyOwner = owner; }
      const cached = this.companyPages.get(company);
      let questions;
      if (cached && Date.now() - cached.time < 300000) questions = cached.questions;
      else {
        const { companyTag } = await this.graphql(`query companyProblems($slug: String!) {
          companyTag(slug: $slug) { questions { questionFrontendId title titleSlug difficulty isPaidOnly status topicTags { name slug } } }
        }`, { slug: company }, { authenticated: Boolean(saved) });
        if (!Array.isArray(companyTag?.questions)) throw new ConnectionError('premium', 'Company problem lists require access from LeetCode, usually a Premium subscription. Open the company page on LeetCode or clear this filter.');
        questions = companyTag.questions.map(q => ({ ...q, titleSlug: validateSlug(q.titleSlug) }));
        if (this.companyPages.size >= 5) this.companyPages.delete(this.companyPages.keys().next().value);
        if (this.companyOwner === owner) this.companyPages.set(company, { questions, time: Date.now() });
      }
      const text = search.trim().toLowerCase();
      const matches = questions.filter(q => (!difficulty || q.difficulty === difficulty) && (!tag || q.topicTags?.some(t => t.slug === tag)) && (!text || `${q.questionFrontendId} ${q.title}`.toLowerCase().includes(text)));
      return { total: matches.length, questions: matches.slice(skip, skip + limit) };
    }
    const filters = {};
    if (search.trim()) filters.searchKeywords = search.trim();
    if (difficulty) filters.difficulty = difficulty.toUpperCase();
    if (tag) filters.tags = [tag];
    const saved = await this.secrets.get(SECRET_KEY);
    const data = await this.graphql(`query problemsetQuestionList($skip: Int, $limit: Int, $filters: QuestionListFilterInput) {
      problemsetQuestionList: questionList(categorySlug: "", skip: $skip, limit: $limit, filters: $filters) {
        total: totalNum questions: data { questionFrontendId title titleSlug difficulty isPaidOnly status topicTags { name slug } }
      }
    }`, { skip, limit, filters }, { authenticated: Boolean(saved) });
    const list = data.problemsetQuestionList;
    if (!Array.isArray(list?.questions) || !Number.isFinite(list.total)) throw new ConnectionError('protocol', 'The problem list format has changed.');
    return { total: list.total, questions: list.questions.map(q => ({ ...q, titleSlug: validateSlug(q.titleSlug) })) };
  }

  async catalog() {
    const data = await this.graphql(`query problemFilters {
      questionTopicTags { edges { node { name slug } } }
      companyTags { name slug }
    }`, {}, { authenticated: false });
    if (!Array.isArray(data.questionTopicTags?.edges) || !Array.isArray(data.companyTags)) throw new ConnectionError('protocol', 'LeetCode did not return problem filters.');
    const tags = values => [...new Map(values.map(tag => {
      if (typeof tag?.name !== 'string' || !tag.name.trim() || tag.name.length > 100) throw new ConnectionError('protocol', 'LeetCode returned an invalid filter.');
      return [validateSlug(tag.slug), { name: tag.name, slug: tag.slug }];
    })).values()].sort((a, b) => a.name.localeCompare(b.name));
    return { tags: tags(data.questionTopicTags.edges.map(edge => edge.node)), companies: tags(data.companyTags) };
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

  async submissions(slug, { offset = 0, limit = 20, lastKey = null } = {}) {
    validateSlug(slug);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50 || (lastKey !== null && (typeof lastKey !== 'string' || lastKey.length > 4096))) throw new Error('Invalid submission history page.');
    const { questionSubmissionList: page } = await this.graphql(`query submissionList($offset: Int!, $limit: Int!, $lastKey: String, $questionSlug: String!) {
      questionSubmissionList(offset: $offset, limit: $limit, lastKey: $lastKey, questionSlug: $questionSlug) {
        lastKey hasNext submissions { id title titleSlug status statusDisplay lang runtime timestamp isPending memory }
      }
    }`, { offset, limit, lastKey, questionSlug: slug });
    if (!Array.isArray(page?.submissions) || typeof page.hasNext !== 'boolean') throw new ConnectionError('protocol', 'LeetCode did not return submission history.');
    const submissions = page.submissions.map(item => {
      if (item.titleSlug !== slug || !Number.isFinite(Number(item.timestamp)) || Number(item.timestamp) <= 0 || !Number.isFinite(new Date(Number(item.timestamp) * 1000).getTime())) throw new ConnectionError('protocol', 'LeetCode returned invalid submission history.');
      return { ...item, id: validateSubmissionId(item.id) };
    });
    return { submissions, hasNext: page.hasNext && submissions.length > 0, lastKey: typeof page.lastKey === 'string' ? page.lastKey : null };
  }

  async submissionDetails(id) {
    const { submissionDetails: details } = await this.graphql(`query submissionDetails($submissionId: Int!) {
      submissionDetails(submissionId: $submissionId) {
        code timestamp statusCode runtime runtimeDisplay runtimePercentile runtimeDistribution
        memory memoryDisplay memoryPercentile memoryDistribution totalCorrect totalTestcases
        stdOutput lastTestcase codeOutput compileError runtimeError
        lang { name } question { questionId title titleSlug } user { username }
      }
    }`, { submissionId: Number(validateSubmissionId(id)) });
    if (!details || typeof details.code !== 'string' || details.code.length > 1_000_000 || typeof details.lang?.name !== 'string' || !details.user?.username) throw new ConnectionError('unavailable', 'The submitted code is unavailable for this account.');
    validateSlug(details.question?.titleSlug);
    return details;
  }

  async submissionStatus(id) {
    const { submissionDetails: details } = await this.graphql(`query submissionStatus($submissionId: Int!) {
      submissionDetails(submissionId: $submissionId) {
        statusCode runtimeDisplay memoryDisplay totalCorrect totalTestcases compileError runtimeError
        question { titleSlug } user { username }
      }
    }`, { submissionId: Number(validateSubmissionId(id)) });
    if (!details || !['number', 'string'].includes(typeof details.statusCode) || !String(details.statusCode).trim() || !Number.isFinite(Number(details.statusCode)) || !details.user?.username) throw new ConnectionError('unavailable', 'The submission verdict is unavailable. Refresh submissions to retry.');
    validateSlug(details.question?.titleSlug);
    return { ...details, statusCode: Number(details.statusCode) };
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

module.exports = { LeetCodeClient, ConnectionError, SECRET_KEY, ORIGIN, validateCredentials, validateSlug, validateRequestId, validateSubmissionId };
