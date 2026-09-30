// Protections for running as a public link: request limits, the wrong-code lockout, and headers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createApp, LIMITS } from '../server/app.js';

let server, base, clock = new Date(2026, 9, 1, 12, 0);
before(async () => {
  server = createApp({ db: openDb(':memory:'), now: () => new Date(clock) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = (method, path, body, from = '203.0.113.1', cookie = '') => fetch(base + path, { method,
  headers: { 'content-type': 'application/json', 'x-shlen': '1', 'x-forwarded-for': from, cookie },
  body: body === undefined ? undefined : JSON.stringify(body) });

let invite;
test('security headers are sent', async () => {
  const res = await call('GET', '/');
  assert.match(res.headers.get('strict-transport-security'), /max-age=/);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  const setup = await call('POST', '/api/setup', { name: 'Alex' });
  invite = (await setup.json()).invite;
});

test('wrong join codes lock joining for an hour, for everyone', async () => {
  for (let i = 0; i < LIMITS.wrongCodesPerHour; i++) {
    assert.equal((await call('POST', '/api/join', { name: 'X', code: 'AAAAAA' }, `198.51.100.${i}`)).status, 403);
  }
  const locked = await call('POST', '/api/join', { name: 'Jordan', code: invite }, '192.0.2.50');
  assert.equal(locked.status, 429, 'even the right code waits while locked');
  clock = new Date(clock.getTime() + 3601e3);
  assert.equal((await call('POST', '/api/join', { name: 'Jordan', code: invite }, '192.0.2.50')).status, 200);
  assert.equal((await call('POST', '/api/join', { name: 'Eve', code: invite }, '192.0.2.51')).status, 409, 'no third person, ever');
});

test('one address hammering sign-in is slowed down, others are not', async () => {
  let last;
  for (let i = 0; i <= LIMITS.openPerMinute; i++) last = await call('POST', '/api/signin/options', { key: `k${i}` }, '203.0.113.9');
  assert.equal(last.status, 429);
  assert.notEqual((await call('POST', '/api/signin/options', { key: 'other' }, '203.0.113.10')).status, 429);
  clock = new Date(clock.getTime() + 61e3);
  assert.notEqual((await call('POST', '/api/signin/options', { key: 'again' }, '203.0.113.9')).status, 429, 'fine again a minute later');
});

test('nothing private is reachable without signing in', async () => {
  for (const [m, p] of [['GET', '/api/state'], ['GET', '/api/topics/1'], ['GET', '/api/export'], ['POST', '/api/check']]) {
    assert.equal((await call(m, p, m === 'POST' ? { text: 'x' } : undefined, '203.0.113.77')).status, 401, p);
  }
});
