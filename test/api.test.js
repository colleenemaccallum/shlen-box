// End-to-end tests through the real HTTP server with an in-memory database and a controllable clock.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';

let server, base, db, clock = new Date(2026, 9, 1, 18, 0);
const logs = [];

before(async () => {
  db = openDb(':memory:');
  server = createApp({ db, now: () => new Date(clock), log: l => logs.push(l) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function client() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-shlen': '1', cookie },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
  };
}
const alex = client(), jordan = client(), stranger = client();
let topicId, alexMsg, jordanMsg;

test('setup and pairing: exactly two people', async () => {
  const s = await alex('POST', '/api/setup', { name: 'Alex' });
  assert.equal(s.status, 200);
  assert.equal((await stranger('POST', '/api/setup', { name: 'Eve' })).status, 409);
  assert.equal((await jordan('POST', '/api/join', { name: 'Jordan', code: 'WRONG1' })).status, 403);
  assert.equal((await jordan('POST', '/api/join', { name: 'Jordan', code: s.body.invite })).status, 200);
  assert.equal((await stranger('POST', '/api/join', { name: 'Eve', code: s.body.invite })).status, 409);
  assert.equal((await stranger('GET', '/api/state')).status, 401);
  const st = await alex('GET', '/api/state');
  assert.equal(st.body.partner.name, 'Jordan');
  assert.equal(st.body.topics.length, 7);
  topicId = st.body.topics.find(t => t.name === 'Money').id;
});

test('requests without the app header are refused (blocks cross-site form posts)', async () => {
  const res = await fetch(base + '/api/topics', { method: 'POST', body: '{"name":"x"}' });
  assert.equal(res.status, 403);
});

test('the private check stores nothing', async () => {
  const count = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    .map(t => db.prepare(`SELECT COUNT(*) n FROM ${t.name}`).get().n).join(',');
  const before = count();
  const r = await alex('POST', '/api/check', { text: "You never listen to anything I say and I'm sick of this." });
  assert.equal(r.body.kind, 'flag');
  assert.equal(count(), before);
  assert.ok(!logs.some(l => l.includes('never listen')), 'draft text must never be logged');
});

test('there is no drafts table', () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
  assert.ok(!tables.some(t => /draft/i.test(t)));
});

test('clear, clarify and safety results', async () => {
  assert.equal((await alex('POST', '/api/check', { text: 'Can we talk about the budget tonight?' })).body.kind, 'clear');
  assert.equal((await alex('POST', '/api/check', { text: "I can't keep doing this" })).body.kind, 'clarify');
  assert.equal((await alex('POST', '/api/check', { text: "I can't keep doing this", clarify: 'this argument' })).body.text, "I can't keep doing this argument");
  assert.equal((await alex('POST', '/api/check', { text: 'I will hurt you' })).body.kind, 'safety');
});

test('sending messages and help me understand only works on the partner\'s messages', async () => {
  alexMsg = (await alex('POST', `/api/topics/${topicId}/messages`, { text: 'Can we agree on an amount that needs a check-in first?' })).body.id;
  jordanMsg = (await jordan('POST', `/api/topics/${topicId}/messages`, { text: "Sure. I didn't think $300 counted as big." })).body.id;
  const own = await alex('POST', `/api/messages/${alexMsg}/understand`);
  assert.equal(own.status, 400);
  const help = await alex('POST', `/api/messages/${jordanMsg}/understand`);
  assert.equal(help.body.kind, 'help');
  assert.match(help.body.main, /Jordan wrote/);
});

test('each person can delete only their own messages, permanently', async () => {
  assert.equal((await jordan('DELETE', `/api/messages/${alexMsg}`)).status, 403);
  const extra = (await alex('POST', `/api/topics/${topicId}/messages`, { text: 'Oops, wrong topic.' })).body.id;
  assert.equal((await alex('DELETE', `/api/messages/${extra}`)).status, 200);
  const row = db.prepare('SELECT text, deleted FROM messages WHERE id = ?').get(extra);
  assert.deepEqual({ ...row }, { text: '', deleted: 1 });
  const seen = (await jordan('GET', `/api/topics/${topicId}`)).body.messages.find(m => m.id === extra);
  assert.equal(seen.text, '');
  assert.equal(seen.deleted, 1);
});

test('Where we are: points only become agreed when both confirm', async () => {
  assert.equal((await alex('POST', `/api/topics/${topicId}/card`)).status, 200);
  let card = (await alex('GET', `/api/topics/${topicId}`)).body.card;
  const draft = card.find(p => p.label === 'draft');
  assert.ok(card.some(p => p.label === 'account'), 'each person\'s account is kept separate');
  assert.equal((await alex('POST', `/api/card-points/${draft.id}/confirm`)).body.agreed, false);
  assert.equal((await alex('POST', `/api/card-points/${draft.id}/confirm`)).body.agreed, false, 'confirming twice alone does not count');
  assert.equal((await jordan('POST', `/api/card-points/${draft.id}/confirm`)).body.agreed, true);
  await alex('POST', `/api/topics/${topicId}/card`);
  card = (await alex('GET', `/api/topics/${topicId}`)).body.card;
  assert.ok(card.some(p => p.id === draft.id && p.label === 'agreed'), 'agreed points survive a refresh');
});

test('Trying a fix and Resolved need both people', async () => {
  await alex('POST', `/api/topics/${topicId}/status`, { to: 'try', checkin: 'Sunday evening' });
  assert.equal((await alex('POST', `/api/topics/${topicId}/status/confirm`)).status, 403);
  let t = (await alex('GET', `/api/topics/${topicId}`)).body.topic;
  assert.equal(t.status, 'open');
  assert.equal((await jordan('POST', `/api/topics/${topicId}/status/confirm`)).status, 200);
  t = (await alex('GET', `/api/topics/${topicId}`)).body.topic;
  assert.equal(t.status, 'try');
  assert.equal(t.checkin, 'Sunday evening');
});

test('pause: holds messages, keeps urgent open, only the pauser ends it early, and it has a maximum', async () => {
  assert.equal((await alex('POST', '/api/pause', { at: new Date(2026, 9, 3, 9).toISOString() })).status, 400);
  assert.equal((await alex('POST', '/api/pause', { minutes: 30, note: 'Back soon' })).status, 200);
  assert.equal((await jordan('POST', '/api/pause', { minutes: 15 })).status, 409);
  assert.equal((await jordan('POST', `/api/topics/${topicId}/messages`, { text: 'Hello?' })).status, 423);
  assert.equal((await alex('POST', `/api/topics/${topicId}/messages`, { text: 'Hello?' })).status, 423);
  assert.equal((await jordan('POST', '/api/urgent', { category: 'Health', text: 'Sam has a fever. Can you grab medicine?' })).status, 200);
  assert.equal((await jordan('POST', '/api/urgent', { category: 'Chat', text: 'hi' })).status, 400);
  assert.equal((await jordan('POST', '/api/urgent', { category: 'Health', text: 'x'.repeat(281) })).status, 400);
  assert.equal((await jordan('POST', '/api/pause/end')).status, 403);
  const st = await jordan('GET', '/api/state');
  assert.equal(st.body.pause.note, 'Back soon');
  assert.equal(st.body.urgent.length, 1);
  clock = new Date(clock.getTime() + 31 * 60e3);
  assert.equal((await jordan('GET', '/api/state')).body.pause, null, 'the pause ends by itself');
  assert.equal((await jordan('POST', `/api/topics/${topicId}/messages`, { text: 'Ready when you are.' })).status, 200);
  assert.equal((await alex('POST', '/api/pause', { minutes: 15 })).status, 200);
  assert.equal((await alex('POST', '/api/pause/end')).status, 200);
});

test('shared rules change only when both agree', async () => {
  await alex('POST', '/api/rules', { key: 'morning_time', value: '08:00' });
  assert.equal((await alex('POST', '/api/rules/confirm')).status, 403);
  assert.equal((await alex('GET', '/api/state')).body.rules.morning_time, '09:00');
  await jordan('POST', '/api/rules/confirm');
  assert.equal((await alex('GET', '/api/state')).body.rules.morning_time, '08:00');
  assert.equal((await alex('POST', '/api/rules', { key: 'morning_time', value: '25:00' })).status, 400);
});

test('deleting a whole topic needs both people', async () => {
  const id = (await alex('POST', '/api/topics', { name: 'Old argument' })).body.id;
  await alex('POST', `/api/topics/${id}/messages`, { text: 'Something.' });
  assert.equal((await alex('POST', `/api/delete/${id}`)).body.pending, true);
  assert.equal((await alex('POST', `/api/delete/${id}`)).body.pending, true, 'the same person asking twice does nothing');
  assert.ok(db.prepare('SELECT id FROM topics WHERE id = ?').get(id));
  assert.equal((await jordan('POST', `/api/delete/${id}`)).body.deleted, true);
  assert.equal(db.prepare('SELECT id FROM topics WHERE id = ?').get(id), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM messages WHERE topic_id = ?').get(id).n, 0);
});

test('export is readable text and marks deleted messages', async () => {
  const r = await alex('GET', '/api/export');
  assert.equal(r.status, 200);
  assert.match(r.body, /Shlen Box export for Alex/);
  assert.match(r.body, /== Money/);
  assert.match(r.body, /\(deleted\)/);
  assert.ok(!r.body.includes('Oops, wrong topic.'));
});

test('static files are served and path traversal is blocked', async () => {
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/..%2fpackage.json')).status, 404);
});

test('help me organize this turns answers into full sentences, in order, with no stock lead-ins', async () => {
  const r = await alex('POST', '/api/organize', { topic_id: topicId,
    answers: ['the dog got heavier', 'She is now very heavy to pick up', 'Please stop feeding her extra', 'I would like her to lose weight'] });
  assert.equal(r.body.kind, 'preview');
  assert.equal(r.body.text, 'The dog got heavier. She is now very heavy to pick up. Please stop feeding her extra. I would like her to lose weight.');
  assert.equal((await alex('POST', '/api/organize', { answers: ['', ' '] })).status, 400);
  assert.equal((await alex('POST', '/api/organize', { answers: ['I will hurt you'] })).body.kind, 'safety');
});

test('the same words sent twice within seconds are one message, not two', async () => {
  const a = await alex('POST', `/api/topics/${topicId}/messages`, { text: 'Double tap test.' });
  const b = await alex('POST', `/api/topics/${topicId}/messages`, { text: 'Double tap test.' });
  assert.equal(b.body.id, a.body.id);
  const count = () => db.prepare("SELECT COUNT(*) AS n FROM messages WHERE text = 'Double tap test.'").get().n;
  assert.equal(count(), 1);
  clock = new Date(clock.getTime() + 60e3);
  await alex('POST', `/api/topics/${topicId}/messages`, { text: 'Double tap test.' });
  assert.equal(count(), 2, 'saying it again later is a new message');
});
