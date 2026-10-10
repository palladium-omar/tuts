import assert from 'node:assert/strict';
import test from 'node:test';
import { homeworkDraftKey, readHomeworkDraft, clearHomeworkDrafts } from '../lib/homework-draft.js';
import { zonedDateInput, zonedDateInstant } from '../lib/zoned-date.js';

test('milestone dates preserve the selected timezone and reject ambiguous clock changes', () => {
  assert.equal(zonedDateInput('2026-10-19T14:15:00Z', 'Europe/London'), '2026-10-19T15:15');
  assert.equal(zonedDateInstant('2026-10-19T15:15', 'Europe/London'), '2026-10-19T14:15:00.000Z');
  assert.equal(zonedDateInstant('2027-01-13T18:00', 'Europe/London'), '2027-01-13T18:00:00.000Z');
  assert.equal(zonedDateInstant('2027-01-13T18:00', 'Asia/Kolkata'), '2027-01-13T12:30:00.000Z');
  assert.equal(zonedDateInstant('', 'UTC'), null);
  assert.throws(() => zonedDateInstant('2027-02-30T18:00', 'UTC'), /valid date/);
  assert.throws(() => zonedDateInstant('2027-03-28T01:30', 'Europe/London'), /clock change/);
  assert.throws(() => zonedDateInstant('2026-10-25T01:30', 'Europe/London'), /clock change/);
  assert.throws(() => zonedDateInstant('2027-04-04T01:45', 'Australia/Lord_Howe'), /clock change/);
});

test('drafts are isolated by author, tenant, student, assignment and current revision', () => {
  const key = homeworkDraftKey('author', 'business', 'student', 'assignment');
  assert.notEqual(key, homeworkDraftKey('guardian', 'business', 'student', 'assignment'));
  const value = { revision: 3, text: 'My answer', url: '', savedAt: 1000 };
  const storage = { getItem: () => JSON.stringify(value) };
  assert.deepEqual(readHomeworkDraft(storage, key, 3, 2000), value);
  assert.equal(readHomeworkDraft(storage, key, 4, 2000), null);
  assert.equal(readHomeworkDraft(storage, key, 3, 1000 + 24*60*60_000), null);
  assert.equal(readHomeworkDraft({getItem: () => 'bad JSON'}, key, 3), null);
  const values = new Map([[key, JSON.stringify(value)], [homeworkDraftKey('guardian','business','student','assignment'), JSON.stringify(value)]]);
  const mutable = {get length() {return values.size;}, key: (index: number) => [...values.keys()][index], removeItem: (name: string) => { values.delete(name); }};
  clearHomeworkDrafts(mutable as Storage, 'author');
  assert.equal(values.size, 1); assert.equal(values.has(key), false);
});
