// Photos, videos and files: only the two people can open them, they go out with a message,
// deleting a message hides them at once, and the file itself goes once no nightly copy needs it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { FILE_MAX, KEEP_REMOVED_DAYS } from '../server/files.js';

let server, base, db, dir, clock = new Date(2026, 9, 1, 18, 0);
before(async () => {
  db = openDb(':memory:');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shlen-files-test-'));
  server = createApp({ db, now: () => new Date(clock), filesDir: dir });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const c = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-shlen': '1', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  c.upload = async (bytes, type, name) => {
    const res = await fetch(base + '/api/files', { method: 'POST', headers: { 'content-type': type, 'x-name': encodeURIComponent(name), 'x-shlen': '1', cookie }, body: bytes });
    return { status: res.status, body: await res.json() };
  };
  c.raw = (p, headers = {}) => fetch(base + p, { headers: { cookie, ...headers } });
  return c;
}
const alex = client(), jordan = client(), stranger = client();
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(2000, 7)]);
let topicId;

test('setup', async () => {
  const s = await alex('POST', '/api/setup', { name: 'Alex' });
  await jordan('POST', '/api/join', { name: 'Jordan', code: s.body.invite });
  topicId = (await alex('GET', '/api/state')).body.topics.find(t => t.name === 'Plans').id;
});

test('a photo goes out with a message and only the two people can open it', async () => {
  const up = await alex.upload(PNG, 'image/png', 'beach day.png');
  assert.equal(up.status, 200);
  assert.equal(up.body.kind, 'image');
  // Before it is sent, only the sender can open it.
  assert.equal((await jordan.raw(`/api/files/${up.body.id}`)).status, 404);
  const sent = await alex('POST', `/api/topics/${topicId}/messages`, { text: 'Look at this', files: [up.body.id] });
  assert.equal(sent.status, 200);
  const t = await jordan('GET', `/api/topics/${topicId}`);
  const m = t.body.messages.at(-1);
  assert.equal(m.text, 'Look at this');
  assert.deepEqual(m.files.map(f => [f.name, f.kind, f.size]), [['beach day.png', 'image', PNG.length]]);
  const res = await jordan.raw(`/api/files/${up.body.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('cache-control'), /private/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  assert.equal((await stranger.raw(`/api/files/${up.body.id}`)).status, 401);
  // A retry of the same send doesn't make a second message.
  const again = await alex('POST', `/api/topics/${topicId}/messages`, { text: 'Look at this', files: [up.body.id] });
  assert.equal(again.body.duplicate, true);
  assert.equal((await jordan('GET', `/api/topics/${topicId}`)).body.messages.length, 1);
});

test('a message can be only a photo; the topic list says so in words', async () => {
  const up = await jordan.upload(PNG, 'image/jpeg', 'x.jpg');
  assert.equal((await jordan('POST', `/api/topics/${topicId}/messages`, { text: '', files: [up.body.id] })).status, 200);
  const st = await alex('GET', '/api/state');
  assert.equal(st.body.topics.find(t => t.id === topicId).last.text, '[photo]');
  assert.ok(st.body.storage.used >= PNG.length * 2);
  // Help me understand works on words only.
  const m = (await alex('GET', `/api/topics/${topicId}`)).body.messages.at(-1);
  assert.equal((await alex('POST', `/api/messages/${m.id}/understand`)).status, 400);
  // Still no empty messages without a file.
  assert.equal((await alex('POST', `/api/topics/${topicId}/messages`, { text: '  ' })).status, 400);
});

test("someone else's upload, or a made-up id, can't be attached", async () => {
  const up = await jordan.upload(PNG, 'image/png', 'y.png');
  assert.equal((await alex('POST', `/api/topics/${topicId}/messages`, { text: 'hi', files: [up.body.id] })).status, 400);
  assert.equal((await alex('POST', `/api/topics/${topicId}/messages`, { text: 'hi', files: ['nope'] })).status, 400);
  assert.equal((await alex('POST', `/api/topics/${topicId}/messages`, { text: 'hi', files: Array(7).fill('a') })).status, 400);
});

test('other files are downloads, never opened in the app; videos play in pieces', async () => {
  const html = await alex.upload(Buffer.from('<script>alert(1)</script>'), 'text/html', 'page.html');
  const vid = await alex.upload(Buffer.alloc(5000, 1), 'video/mp4', 'clip.mp4');
  await alex('POST', `/api/topics/${topicId}/messages`, { text: 'two things', files: [html.body.id, vid.body.id] });
  const r = await jordan.raw(`/api/files/${html.body.id}`);
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.match(r.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''page\.html$/);
  assert.match(r.headers.get('content-security-policy'), /sandbox/);
  const part = await jordan.raw(`/api/files/${vid.body.id}`, { range: 'bytes=100-199' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 100-199/5000');
  assert.equal((await part.arrayBuffer()).byteLength, 100);
  const st = await alex('GET', '/api/state');
  assert.equal(st.body.topics.find(t => t.id === topicId).last.text, 'two things [2 attachments]');
});

test('files that are too big are refused, and nothing is left behind', async () => {
  const big = await alex.upload(Buffer.alloc(FILE_MAX + 1), 'video/mp4', 'long.mp4');
  assert.equal(big.status, 413);
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.part')), []);
});

test('deleting a message hides its photo at once; the file goes after the nightly copies expire', async () => {
  const up = await alex.upload(PNG, 'image/png', 'gone.png');
  const { body } = await alex('POST', `/api/topics/${topicId}/messages`, { text: 'oops', files: [up.body.id] });
  assert.equal((await alex('DELETE', `/api/messages/${body.id}`)).status, 200);
  assert.equal((await jordan.raw(`/api/files/${up.body.id}`)).status, 404);
  assert.ok(fs.existsSync(path.join(dir, up.body.id)));
  // An upload whose message never arrived goes after an hour.
  const stray = await alex.upload(PNG, 'image/png', 'stray.png');
  clock = new Date(clock.getTime() + 2 * 3600e3); server.tick();
  assert.ok(!fs.existsSync(path.join(dir, stray.body.id)));
  assert.ok(fs.existsSync(path.join(dir, up.body.id)));
  clock = new Date(clock.getTime() + (KEEP_REMOVED_DAYS + 1) * 86400e3); server.tick();
  assert.ok(!fs.existsSync(path.join(dir, up.body.id)));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM files WHERE id = ?').get(up.body.id).n, 0);
});

test('uploads wait during a pause, like messages', async () => {
  await jordan('POST', '/api/pause', { minutes: 15 });
  assert.equal((await alex.upload(PNG, 'image/png', 'p.png')).status, 423);
  await jordan('POST', '/api/pause/end');
});

test('the export lists attachments in words', async () => {
  const res = await alex.raw('/api/export');
  assert.match(await res.text(), /Look at this \[photo\]/);
});
