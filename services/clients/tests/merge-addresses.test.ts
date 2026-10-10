import assert from 'node:assert/strict';
import test from 'node:test';
import { selectMergeAddresses } from '../src/merge-addresses.js';

const emails = [
  { value: 'student@example.com', label: 'personal' },
  { value: 'student@school.example', label: 'school' },
];

test('multiple addresses require explicit retention, even from an older primary-only dialog', () => {
  assert.throws(() => selectMergeAddresses('email', emails, {}), /Choose which email addresses to keep/);
  assert.throws(() => selectMergeAddresses('email', emails, { primary: emails[0].value }), /Choose which email addresses to keep/);
});

test('choosing one address excludes the other and sets an available primary', () => {
  const result = selectMergeAddresses('email', emails, { retained: [emails[1].value], preferred: emails[0].value });
  assert.deepEqual(result.addresses, [emails[1]]);
  assert.equal(result.primary, emails[1].value);
  const legacy = selectMergeAddresses('email', emails, { legacyChoice: emails[0].value });
  assert.deepEqual(legacy.addresses, [emails[0]]);
});

test('explicit keep-all preserves both labels and the selected primary', () => {
  const result = selectMergeAddresses('email', emails, { retained: emails.map(address => address.value), primary: emails[1].value });
  assert.deepEqual(result.addresses, emails);
  assert.equal(result.primary, emails[1].value);
});

test('unknown addresses, empty decisions and a discarded primary reject the merge', () => {
  assert.throws(() => selectMergeAddresses('email', emails, { retained: ['unrelated@example.com'] }), /from the merge preview/);
  assert.throws(() => selectMergeAddresses('email', emails, { retained: [] }), /at least one email/);
  assert.throws(() => selectMergeAddresses('email', emails, { retained: [emails[0].value], primary: emails[1].value }), /from the addresses you are keeping/);
});

test('selection normalizes case without collapsing different addresses and rejects duplicate decisions', () => {
  const choices = [{ value: 'a.b@example.com', label: 'home' }, { value: 'ab@example.com', label: 'work' }];
  const result = selectMergeAddresses('email', choices, { retained: ['A.B@example.com', 'ab@example.com'] });
  assert.equal(result.addresses.length, 2);
  assert.throws(() => selectMergeAddresses('email', choices, { retained: ['a.b@example.com', 'A.B@example.com'] }), /distinct email values/);
  const phones = [{ value: '+1 555 123 4567', label: 'mobile' }, { value: '+1 555 765 4321', label: 'home' }];
  assert.deepEqual(selectMergeAddresses('phone', phones, { retained: ['+15557654321'] }).addresses, [phones[1]]);
});

test('a single unambiguous address is retained and an empty kind stays empty', () => {
  assert.deepEqual(selectMergeAddresses('email', [emails[0]], {}).addresses, [emails[0]]);
  assert.deepEqual(selectMergeAddresses('phone', [], {}), { addresses: [], primary: null });
});
