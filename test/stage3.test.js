// Stage 3: the real AI coach, tested against a fake AI service (no key, no spending).
// Checks what is sent (current topic only, no real names), what comes back, and the spending cap.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { createAiCoach, MODEL } from '../server/ai-coach.js';

let server, base, db, clock = new Date(Date.UTC(2026, 9, 15, 18, 0));
const calls = [];
let next = []; // scripted replies, each a JSON object, an Error to throw, or a full response
const fakeClient = { messages: {}, beta: { messages: { create: async params => {
  calls.push(params);
  const r = next.shift();
  if (r instanceof Error) throw r;
  if (r?.raw) return r.raw;
  return { stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 500 }, content: [{ type: 'text', text: JSON.stringify(r) }] };
} } } };
const blank = { issues: [], versions: [], question: '', options: [] };

before(async () => {
  db = openDb(':memory:');
  const coach = createAiCoach({ db, client: fakeClient, now: () => new Date(clock), capUsd: 10 });
  server = createApp({ db, now: () => new Date(clock), coach });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function client() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-shlen': '1', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}
const alex = client(), jordan = client();
let topicId, otherTopicId, jordanMsg;
const sentText = () => JSON.stringify(calls.at(-1));

test('setup and a short conversation', async () => {
  const { body } = await alex('POST', '/api/setup', { name: 'Alex' });
  await jordan('POST', '/api/join', { name: 'Jordan', code: body.invite });
  const st = (await alex('GET', '/api/state')).body;
  assert.equal(st.stand_in_coach, false, 'the stand-in banner goes away');
  topicId = st.topics.find(t => t.name === 'Money').id;
  otherTopicId = st.topics.find(t => t.name !== 'Money').id;
  await alex('POST', `/api/topics/${otherTopicId}/messages`, { text: 'Secret from another topic.' });
  await alex('POST', `/api/topics/${topicId}/messages`, { text: 'Jordan, can we set a budget? Alex here.' });
  jordanMsg = (await jordan('POST', `/api/topics/${topicId}/messages`, { text: 'Alex, I feel like I always have to ask first.' })).body.id;
});

test('a check sends only this topic, with names replaced, and returns the review', async () => {
  next.push({ ...blank, kind: 'flag', issues: [{ phrase: 'you never', why: 'Person B may list exceptions.' }, { phrase: 'it drives me nuts', why: 'Aims the anger at Person B.' }],
    versions: ['Person B, it often feels like you skip this, and I get frustrated.', 'v2', 'v3'] });
  const r = (await alex('POST', '/api/check', { text: 'Jordan you never plan ahead and it drives me nuts.', topic_id: topicId })).body;
  const p = calls.at(-1);
  assert.equal(p.model, MODEL);
  assert.equal(p.output_config.format.type, 'json_schema');
  assert.ok(!/Alex|Jordan/.test(sentText()), 'no real names leave the server');
  assert.ok(sentText().includes('Person B you never plan ahead and it drives me nuts.'));
  assert.ok(sentText().includes('I always have to ask first'), 'recent messages of this topic are included');
  assert.ok(!sentText().includes('Secret from another topic'), 'other topics never are');
  assert.equal(r.kind, 'flag');
  assert.equal(r.phrase, 'you never');
  assert.equal(r.why, 'Jordan may list exceptions.', 'names are put back for the author');
  assert.deepEqual(r.issues.map(i => i.phrase), ['you never', 'it drives me nuts'], 'every harsh part is listed');
  assert.equal(r.issues[1].why, 'Aims the anger at Jordan.');
  assert.equal(r.versions[0], 'Jordan, it often feels like you skip this, and I get frustrated.');
});

test('a flagged phrase that is not in the draft is dropped rather than shown wrong', async () => {
  next.push({ ...blank, kind: 'flag', issues: [{ phrase: 'something else', why: 'w' }], versions: ['a'] });
  const r = (await alex('POST', '/api/check', { text: 'Fine.', topic_id: topicId })).body;
  assert.equal(r.phrase, '');
});

test('clear, clarify, and safety', async () => {
  next.push({ ...blank, kind: 'clear' });
  assert.equal((await alex('POST', '/api/check', { text: 'Can we talk tonight?', topic_id: topicId })).body.kind, 'clear');
  next.push({ ...blank, kind: 'clarify', question: 'What does "this" mean?', options: ['this argument', 'the budget'] });
  const c = (await alex('POST', '/api/check', { text: "I can't keep doing this", topic_id: topicId })).body;
  assert.deepEqual([c.kind, c.options], ['clarify', ['this argument', 'the budget']]);
  next.push({ text: "I can't keep doing the budget this way" });
  const pv = (await alex('POST', '/api/check', { text: "I can't keep doing this", topic_id: topicId, clarify: 'the budget' })).body;
  assert.deepEqual(pv, { kind: 'preview', text: "I can't keep doing the budget this way" });
  const before = calls.length;
  assert.equal((await alex('POST', '/api/check', { text: 'I will hurt you', topic_id: topicId })).body.kind, 'safety');
  assert.equal(calls.length, before, 'clear threats are caught before anything is sent');
});

test('help me understand restates from the reader side', async () => {
  next.push({ kind: 'help', main: 'Person B feels they always have to ask first.', request: 'No direct request.',
    ask: 'What would feel fairer to you?', heard: "you feel you always have to ask me first" });
  const h = (await alex('POST', `/api/messages/${jordanMsg}/understand`)).body;
  assert.ok(!/Alex|Jordan/.test(sentText()));
  assert.equal(h.main, 'Jordan wrote: Jordan feels they always have to ask first.');
  assert.equal(h.heard, 'you feel you always have to ask me first');
});

test('the card drafts points and links each account to its person', async () => {
  next.push({ points: [
    { section: 'The issue', text: 'How spending decisions get made.', account_of: '' },
    { section: 'Still different', text: 'Person B feels they always ask first.', account_of: 'Person B' },
    { section: 'Open question', text: 'What amount needs a check-in?', account_of: '' },
  ] });
  assert.equal((await alex('POST', `/api/topics/${topicId}/card`)).status, 200);
  const card = (await alex('GET', `/api/topics/${topicId}`)).body.card;
  const acct = card.find(p => p.section === 'Still different');
  assert.equal(acct.text, 'Jordan feels they always ask first.');
  assert.equal(acct.label, 'account');
  assert.equal(acct.account_of, (await alex('GET', '/api/state')).body.partner.id);
});

test('when the AI fails or refuses, the author is told and can still send', async () => {
  next.push(new Anthropic.APIConnectionTimeoutError());
  assert.equal((await alex('POST', '/api/check', { text: 'Hello', topic_id: topicId })).body.kind, 'unavailable');
  next.push({ raw: { stop_reason: 'refusal', usage: { input_tokens: 10, output_tokens: 0 }, content: [] } });
  assert.equal((await alex('POST', '/api/check', { text: 'Hello', topic_id: topicId })).body.kind, 'unavailable');
  next.push(new Anthropic.InternalServerError(500, {}, 'boom', new Headers()));
  const u = await alex('POST', `/api/messages/${jordanMsg}/understand`);
  assert.equal(u.status, 503);
  assert.equal((await alex('POST', `/api/topics/${topicId}/messages`, { text: 'Sent anyway.' })).status, 200);
});

test('spending is counted, and nothing is sent once the cap would be passed', async () => {
  const month = clock.toISOString().slice(0, 7);
  const rows = db.prepare('SELECT kind, input_tokens, output_tokens, usd FROM ai_usage WHERE month = ?').all(month);
  const normal = rows.find(r => r.input_tokens === 1000);
  assert.equal(normal.usd, (1000 * 4 + 500 * 20) / 1e6, 'billed at the model rate');
  assert.ok(rows.some(r => r.usd > 0.1), 'a timed-out request keeps its reserved amount');
  assert.ok(rows.some(r => r.usd === 0), 'an answered error is not counted');
  db.prepare("INSERT INTO ai_usage (month, kind, usd, created) VALUES (?, 'test', ?, ?)").run(month, 9.95, clock.toISOString());
  const before = calls.length;
  const r = (await alex('POST', '/api/check', { text: 'Hello again', topic_id: topicId })).body;
  assert.equal(r.kind, 'capped');
  assert.match(r.message, /Coaching is paused until November 1/);
  assert.equal(calls.length, before, 'no request was made');
  const card = await alex('POST', `/api/topics/${topicId}/card`);
  assert.equal(card.status, 503);
  assert.match(card.body.error, /AI budget/);
  clock = new Date(Date.UTC(2026, 10, 1, 0, 5));
  next.push({ ...blank, kind: 'clear' });
  assert.equal((await alex('POST', '/api/check', { text: 'New month', topic_id: topicId })).body.kind, 'clear', 'coaching resumes next month');
});

test('the AI key can be connected in Settings by the person who set up, and is never sent back', async () => {
  const { createCoachSwitch } = await import('../server/coach-switch.js');
  const db2 = openDb(':memory:');
  const good = 'sk-ant-api03-GOODKEY';
  let made = 0;
  const sw = createCoachSwitch({ db: db2, now: () => new Date(clock), verify: async k => k === good,
    makeAi: o => { made++; return createAiCoach({ ...o, client: fakeClient }); } });
  const s2 = createApp({ db: db2, now: () => new Date(clock), coach: sw });
  await new Promise(r => s2.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const mk = () => { let cookie = ''; return async (method, path, body) => {
    const res = await fetch(b2 + path, { method, headers: { 'content-type': 'application/json', 'x-shlen': '1', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) }; }; };
  const a = mk(), b = mk();
  const inv = (await a('POST', '/api/setup', { name: 'Alex' })).body.invite;
  await b('POST', '/api/join', { name: 'Jordan', code: inv });
  let st = (await a('GET', '/api/state')).body;
  assert.equal(st.stand_in_coach, true);
  assert.equal(st.ai.connected, false);
  assert.equal((await b('POST', '/api/ai-key', { key: good })).status, 403, 'only the person who set up');
  assert.equal((await a('POST', '/api/ai-key', { key: 'hello' })).status, 400);
  assert.equal((await a('POST', '/api/ai-key', { key: 'sk-ant-api03-WRONG' })).status, 400);
  assert.equal((await a('POST', '/api/ai-key', { key: good })).status, 200);
  st = (await a('GET', '/api/state')).body;
  assert.equal(st.stand_in_coach, false);
  assert.deepEqual(st.ai, { connected: true, from_settings: true, spent: 0, cap: 10 });
  assert.ok(!JSON.stringify(st).includes('GOODKEY') && !JSON.stringify((await b('GET', '/api/state')).body).includes('GOODKEY'));
  next.push({ ...blank, kind: 'clear' });
  assert.equal((await a('POST', '/api/check', { text: 'Hi', topic_id: st.topics[0].id })).body.kind, 'clear');
  assert.equal(made, 1);
  assert.equal((await a('DELETE', '/api/ai-key')).status, 200);
  assert.equal((await a('GET', '/api/state')).body.stand_in_coach, true);
  s2.close();
});
