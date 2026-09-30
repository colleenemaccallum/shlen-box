// Stage 2: app lock, passkey sign-in flow, and content-free notifications.
// The passkey cryptography itself is exercised in the browser test with a virtual authenticator;
// here a fake stands in so the server's rules can be tested directly.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createApp, LOCK_AFTER_MS } from '../server/app.js';
import { createNotifier } from '../server/notify.js';

let server, base, db, clock = new Date(2026, 9, 1, 18, 0);
const sent = [];
const registered = new Set();
const fakePasskeys = {
  hasPasskey: id => registered.has(id),
  registrationOptions: async () => ({ challenge: 'x' }),
  register: async (person, response) => { if (response?.ok) { registered.add(person.id); return true; } return false; },
  authenticationOptions: async () => ({ challenge: 'y' }),
  authenticate: async (key, response, only) => (response?.ok && (!only || only === response.person) ? response.person : null),
};

before(async () => {
  db = openDb(':memory:');
  const notifier = createNotifier({ db, send: (sub, payload) => sent.push({ endpoint: sub.endpoint, ...payload }) });
  server = createApp({ db, now: () => new Date(clock), passkeys: fakePasskeys, notifier, vapidPublicKey: 'test-key' });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function client() {
  let cookie = '';
  const c = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-shlen': '1', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  c.forget = () => { cookie = ''; };
  return c;
}
const alex = client(), jordan = client();
let alexId, jordanId, topicId;
const sub = n => ({ subscription: { endpoint: `https://push.example/${n}`, keys: { p256dh: 'p', auth: 'a' } } });

test('setup, passkey registration, notification subscriptions', async () => {
  const { body } = await alex('POST', '/api/setup', { name: 'Alex' });
  await jordan('POST', '/api/join', { name: 'Jordan', code: body.invite });
  const st = (await alex('GET', '/api/state')).body;
  alexId = st.me.id; jordanId = st.partner.id; topicId = st.topics[0].id;
  assert.equal(st.has_passkey, false);
  assert.equal(st.push_key, 'test-key');
  assert.equal((await alex('POST', '/api/passkey', { response: { ok: false } })).status, 400);
  assert.equal((await alex('POST', '/api/passkey', { response: { ok: true } })).status, 200);
  assert.equal((await alex('GET', '/api/state')).body.has_passkey, true);
  assert.equal((await alex('POST', '/api/push/subscribe', { subscription: { endpoint: 'http://insecure', keys: { p256dh: 'p', auth: 'a' } } })).status, 400);
  assert.equal((await alex('POST', '/api/push/subscribe', sub('alex'))).status, 200);
  assert.equal((await jordan('POST', '/api/push/subscribe', sub('jordan'))).status, 200);
});

test('notifications go to the partner and never contain message text', async () => {
  sent.length = 0;
  await alex('POST', `/api/topics/${topicId}/messages`, { text: 'A very private sentence about money.' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].endpoint, 'https://push.example/jordan');
  assert.equal(sent[0].title, 'New message in Parenting');
  assert.ok(!JSON.stringify(sent).includes('private sentence'));
});

test('muting stops everything except urgent messages', async () => {
  await jordan('POST', '/api/prefs', { mute: true });
  sent.length = 0;
  await alex('POST', `/api/topics/${topicId}/messages`, { text: 'Another one.' });
  assert.equal(sent.length, 0);
  await alex('POST', '/api/urgent', { category: 'Health', text: 'Sam has a fever and needs medicine.' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'Urgent message from Alex (Health)');
  assert.ok(!sent[0].title.includes('fever'));
  await jordan('POST', '/api/prefs', { mute: false });
});

test('pause start and its natural end are announced, once', async () => {
  sent.length = 0;
  await jordan('POST', '/api/pause', { minutes: 15 });
  assert.deepEqual(sent.map(s => s.title), ['Jordan asked for time to process']);
  sent.length = 0;
  server.tick();
  assert.equal(sent.length, 0, 'nothing while the pause is running');
  clock = new Date(clock.getTime() + 16 * 60e3);
  server.tick(); server.tick();
  assert.deepEqual(sent.map(s => s.title).sort(), ['Talking is open again', 'Talking is open again']);
});

test('the app locks after 5 idle minutes for someone with a passkey, and unlocks only with it', async () => {
  clock = new Date(clock.getTime() + LOCK_AFTER_MS + 1000);
  const locked = await alex('GET', '/api/state');
  assert.equal(locked.status, 401);
  assert.equal(locked.body.locked, true);
  assert.equal((await alex('POST', `/api/topics/${topicId}/messages`, { text: 'x' })).status, 401);
  assert.equal((await jordan('GET', '/api/state')).status, 200, 'no passkey yet, so no lock');
  await alex('POST', '/api/unlock/options');
  assert.equal((await alex('POST', '/api/unlock', { response: { ok: true, person: jordanId } })).status, 401, "can't unlock with the partner's passkey");
  assert.equal((await alex('POST', '/api/unlock', { response: { ok: true, person: alexId } })).status, 200);
  assert.equal((await alex('GET', '/api/state')).status, 200);
});

test('activity keeps the app unlocked', async () => {
  clock = new Date(clock.getTime() + LOCK_AFTER_MS - 1000);
  assert.equal((await alex('GET', '/api/state')).status, 200);
  clock = new Date(clock.getTime() + LOCK_AFTER_MS - 1000);
  assert.equal((await alex('GET', '/api/state')).status, 200);
});

test('signing in with a passkey on a new phone creates a new session', async () => {
  alex.forget();
  assert.equal((await alex('GET', '/api/state')).status, 401);
  await alex('POST', '/api/signin/options', { key: 'k1' });
  assert.equal((await alex('POST', '/api/signin', { key: 'k1', response: { ok: false } })).status, 401);
  assert.equal((await alex('POST', '/api/signin', { key: 'k1', response: { ok: true, person: alexId } })).status, 200);
  assert.equal((await alex('GET', '/api/state')).body.me.name, 'Alex');
});
