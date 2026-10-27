'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

class Journal {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, 'attempts.json');
    this.records = [];
    this.queue = Promise.resolve();
  }

  async load() {
    let text;
    try { text = await fs.readFile(this.file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    let value;
    try { value = JSON.parse(text); }
    catch { throw new Error('The attempt journal could not be read. It has been preserved; do not delete it before recovering your snapshots.'); }
    if (value.version !== 1 || !Array.isArray(value.records)) throw new Error('Unsupported attempt journal. The original file has been preserved.');
    this.records = value.records;
    let changed = false;
    for (const record of this.records) {
      if (record.status === 'sending' || record.status === 'prepared') {
        record.status = record.remoteId ? 'pending' : 'uncertain';
        record.error = 'The editor stopped before the request status was recorded. Check LeetCode history before sending another attempt.';
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  list() { return structuredClone(this.records); }
  get(id) { return structuredClone(this.records.find(record => record.id === id)); }

  async create({ kind, problem, language, code, cases, owner, fileUri }) {
    const record = {
      id: randomUUID(), kind, slug: problem.titleSlug, title: problem.title,
      questionId: problem.questionId, language, code, cases: structuredClone(cases), owner, fileUri,
      snapshot: createHash('sha256').update(code).digest('hex').slice(0, 12),
      createdAt: new Date().toISOString(), status: 'prepared'
    };
    this.records.unshift(record);
    const completed = { run: 0, submit: 0 };
    this.records = this.records.filter(item => item.status !== 'complete' || (completed[item.kind] = (completed[item.kind] || 0) + 1) <= 100);
    await this.persist();
    return structuredClone(record);
  }

  async update(id, fields) {
    const record = this.records.find(item => item.id === id);
    if (!record) throw new Error('This attempt is not in the local journal.');
    Object.assign(record, fields);
    await this.persist();
    return structuredClone(record);
  }

  async persist() {
    const content = JSON.stringify({ version: 1, records: this.records });
    const operation = this.queue.then(async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(this.directory, `attempts.${randomUUID()}.tmp`);
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(temporary, this.file);
      } catch (error) {
        await fs.unlink(temporary).catch(() => {});
        throw new Error(`Could not save the attempt journal (${error.code || 'storage error'}). No new request should be sent until storage works.`);
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

module.exports = { Journal };
