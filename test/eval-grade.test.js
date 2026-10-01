// The test scorer itself: checked with made-up coach answers, so no AI is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { grade } from '../eval/grade.js';

const flag = (issues, versions = ['v']) => ({ kind: 'flag', issues, versions, question_asked: '' });

test('every case in the test sets has an id, a draft and an expectation', () => {
  const { sets } = JSON.parse(readFileSync(new URL('../eval/cases.json', import.meta.url)));
  const all = Object.values(sets).flat();
  assert.equal(new Set(all.map(c => c.id)).size, all.length, 'ids are unique');
  for (const c of all) assert.ok(c.draft && c.expect, c.id);
});

test('honest anger that gets flagged fails; the absolute being flagged passes', () => {
  const c = { draft: 'You never help and it pisses me off.', expect: { kind: 'flag', flagged: ['never'], not_flagged: ['pisses me off'], keep_some: ['piss'] } };
  assert.deepEqual(grade(c, flag([{ type: 'wording', phrase: 'You never', why: 'w' }], ['I do most of it and it pisses me off.'])), []);
  const bad = grade(c, flag([{ type: 'wording', phrase: 'it pisses me off', why: 'w' }], ['I feel frustrated.']));
  assert.ok(bad.some(b => b.includes('did not flag "never"')));
  assert.ok(bad.some(b => b.includes('should stay')));
  assert.ok(bad.some(b => b.includes('no version keeps')));
});

test('structure types, the question, safety type, added apologies and therapy words are checked', () => {
  const c = { draft: 'Maybe if you weren\'t yelling you\'d know.', expect: { kind: 'flag', types: ['unanswered', 'new_issue'], question: true } };
  assert.equal(grade(c, flag([{ type: 'wording', phrase: '', why: 'w' }])).length, 2);
  assert.deepEqual(grade(c, { ...flag([{ type: 'unanswered', phrase: '', why: 'w' }]), question_asked: 'Did the dog go out?' }), []);
  assert.ok(grade({ draft: 'x', expect: { kind: 'safety', safety_type: 'harm' } }, { kind: 'safety', safety_type: 'threatened' }).length);
  assert.deepEqual(grade({ draft: 'x', expect: { kind_not: 'safety' } }, { kind: 'clear' }), []);
  assert.ok(grade({ draft: 'x', expect: { kind: 'flag' } }, flag([{ type: 'wording', phrase: '', why: 'w' }], ["I'm sorry, but..."]))[0].includes('apology'));
  assert.ok(grade({ draft: 'x', expect: { kind: 'flag' } }, flag([{ type: 'wording', phrase: '', why: 'This is stonewalling.' }]))[0].includes('therapy'));
});
