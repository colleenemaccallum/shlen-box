// HTTP server: JSON API plus static files for the phone app.
// Privacy rules enforced here: no request bodies are logged, draft text sent for checking is never stored,
// and every check about "who may do what" happens on the server.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { tx, STARTER_TOPICS } from './db.js';
import * as rules from './rules.js';
import * as stand_in from './coach.js';
import { CoachUnavailable } from './ai-coach.js';
import { createFiles } from './files.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
// Changes whenever an update changes the phone app, so open phones know to reload.
const BUILD = crypto.createHash('sha256').update(['app.js', 'app.css'].map(f => { try { return fs.readFileSync(path.join(PUBLIC, f)); } catch { return ''; } }).join('')).digest('hex').slice(0, 12);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const BODY_LIMIT = 16 * 1024;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

// Limits for a server that may be reachable from the internet. Counts are per address per minute,
// plus a lockout on wrong join codes that applies to everyone.
export const LIMITS = { apiPerMinute: 240, openPerMinute: 20, wrongCodesPerHour: 10 };
const fail = (status, message) => { throw new HttpError(status, message); };
const hash = t => crypto.createHash('sha256').update(t).digest('hex');

export const LOCK_AFTER_MS = 5 * 60e3;
export const DUPLICATE_WINDOW_MS = 30e3;

export function createApp({ db, now = () => new Date(), coach = stand_in, log = () => {}, secureCookies = false,
  passkeys = null, notifier = { notify: () => [] }, vapidPublicKey = null,
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shlen-files-')) }) {
  const iso = () => now().toISOString();
  const q = sql => db.prepare(sql);
  const files = createFiles({ db, dir: filesDir, now, fail });

  // ---------- helpers ----------
  const people = () => q('SELECT id, name, role FROM people ORDER BY role').all();
  const personById = id => q('SELECT id, name, role FROM people WHERE id = ?').get(id);
  const partnerOf = me => q('SELECT id, name, role FROM people WHERE id != ?').get(me.id) || null;
  const getRules = () => Object.fromEntries(q('SELECT key, value FROM rules').all().map(r => [r.key, r.value]));
  const topicOr404 = id => q('SELECT * FROM topics WHERE id = ?').get(id) || fail(404, 'That topic was not found.');
  const touch = id => q('UPDATE topics SET updated = ? WHERE id = ?').run(iso(), id);

  function activePause() {
    const p = q('SELECT * FROM pauses WHERE ended_early IS NULL ORDER BY id DESC LIMIT 1').get();
    return p && new Date(p.end) > now() ? p : null;
  }

  function newSession(res, personId) {
    const token = crypto.randomBytes(32).toString('base64url');
    q('INSERT INTO sessions (token_hash, person_id, created, last_seen) VALUES (?, ?, ?, ?)').run(hash(token), personId, iso(), iso());
    res.setHeader('Set-Cookie', `sb=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secureCookies ? '; Secure' : ''}`);
  }

  // Returns { person, tokenHash, locked }. A session locks after 5 idle minutes once the person has a passkey.
  function currentSession(req) {
    const m = /(?:^|;\s*)sb=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '');
    if (!m) return null;
    const s = q('SELECT * FROM sessions WHERE token_hash = ?').get(hash(m[1]));
    if (!s) return null;
    const person = personById(s.person_id);
    const locked = !!passkeys?.hasPasskey(person.id) && now() - new Date(s.last_seen) > LOCK_AFTER_MS;
    return { person, tokenHash: s.token_hash, locked };
  }
  const seen = tokenHash => q('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(iso(), tokenHash);
  const tellPartner = (me, kind, title) => { const p = partnerOf(me); if (p) notifier.notify(p.id, kind, title); };

  function text(v, max, what) {
    if (typeof v !== 'string' || !v.trim()) fail(400, `${what} can't be empty.`);
    if (v.length > max) fail(400, `${what} is too long (${max} characters at most).`);
    return v.trim();
  }

  function cardFor(topicId, me) {
    const pts = q('SELECT * FROM card_points WHERE topic_id = ? ORDER BY id').all(topicId);
    return pts.map(p => ({
      id: p.id, section: p.section, text: p.text, label: p.label, account_of: p.account_of,
      confirmed_by: q('SELECT person_id FROM card_confirmations WHERE point_id = ?').all(p.id).map(r => r.person_id),
    }));
  }

  // ---------- limits ----------
  const hits = new Map(); // "bucket|address|minute" -> count
  function limit(bucket, addr, max) {
    const minute = Math.floor(now().getTime() / 60e3), key = `${bucket}|${addr}|${minute}`;
    if (hits.size > 5000) for (const k of hits.keys()) if (!k.endsWith(`|${minute}`)) hits.delete(k);
    const n = (hits.get(key) || 0) + 1; hits.set(key, n);
    if (n > max) fail(429, 'Too many tries. Please wait a minute.');
  }
  let wrongCodes = [];
  function joinLocked() { const hourAgo = now().getTime() - 3600e3; wrongCodes = wrongCodes.filter(t => t > hourAgo); return wrongCodes.length >= LIMITS.wrongCodesPerHour; }
  // The app only listens on this machine, so the forwarding header comes from Tailscale.
  const clientAddr = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler, { auth = true, locked = false, raw = false } = {}) =>
    routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, auth, locked, raw });
  const HANDLED = Symbol('handled'); // the handler wrote the response itself

  route('GET', '/api/setup', () => ({ people: people().length }), { auth: false });

  route('POST', '/api/setup', ({ body, res }) => {
    const name = text(body.name, 40, 'Your name');
    const code = tx(db, () => {
      if (people().length) fail(409, 'Shlen Box is already set up.');
      const { lastInsertRowid: id } = q("INSERT INTO people (name, role, created) VALUES (?, 'A', ?)").run(name, iso());
      const put = q('INSERT INTO topics (name, created, updated) VALUES (?, ?, ?)');
      for (const t of STARTER_TOPICS) put.run(t, iso(), iso());
      const code = crypto.randomInt(0, 36 ** 6).toString(36).toUpperCase().padStart(6, '0');
      q('INSERT INTO invites (code, created) VALUES (?, ?)').run(code, iso());
      newSession(res, Number(id));
      return code;
    });
    return { invite: code };
  }, { auth: false });

  route('POST', '/api/join', ({ body, res }) => {
    const name = text(body.name, 40, 'Your name');
    const code = text(body.code, 12, 'The code').toUpperCase();
    tx(db, () => {
      if (people().length !== 1) fail(409, 'Shlen Box already has two people. No more accounts can be made.');
      if (joinLocked()) fail(429, 'Too many wrong codes. Joining is paused for an hour.');
      const inv = q('SELECT * FROM invites WHERE code = ? AND used = 0').get(code);
      if (!inv) { wrongCodes.push(now().getTime()); fail(403, 'That code is not right. Check it with your partner.'); }
      q('UPDATE invites SET used = 1 WHERE code = ?').run(code);
      const { lastInsertRowid: id } = q("INSERT INTO people (name, role, created) VALUES (?, 'B', ?)").run(name, iso());
      newSession(res, Number(id));
    });
    return { ok: true };
  }, { auth: false });

  route('POST', '/api/logout', ({ req, res }) => {
    const m = /(?:^|;\s*)sb=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '');
    if (m) q('DELETE FROM sessions WHERE token_hash = ?').run(hash(m[1]));
    res.setHeader('Set-Cookie', 'sb=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return { ok: true };
  }, { locked: true });

  route('GET', '/api/state', ({ me }) => {
    const partner = partnerOf(me);
    const invite = !partner ? q('SELECT code FROM invites WHERE used = 0').get()?.code : undefined;
    const topics = q('SELECT * FROM topics ORDER BY updated DESC').all().map(t => {
      const last = q('SELECT id, author, text, deleted FROM messages WHERE topic_id = ? ORDER BY id DESC LIMIT 1').get(t.id);
      if (last && !last.deleted) last.text = withFiles(last);
      return { ...t,
        status_request: q('SELECT by_person, to_status, checkin FROM status_requests WHERE topic_id = ?').get(t.id) || null,
        delete_request: q('SELECT by_person FROM delete_requests WHERE topic_id = ?').get(t.id) || null,
        last: last ? { author: last.author, text: last.deleted ? '' : last.text.slice(0, 80), deleted: !!last.deleted } : null };
    });
    return {
      me, partner, invite, rules: getRules(),
      rule_request: q('SELECT key, value, by_person FROM rule_requests').get() || null,
      wipe_request: q('SELECT by_person FROM delete_requests WHERE topic_id = 0').get() || null,
      pause: activePause(),
      pause_limits: { morning: rules.maxPauseEnd(now(), getRules().morning_time).toISOString(),
        tonight: rules.nextAt(now(), getRules().tonight_time).toISOString() },
      pauses_recent: q('SELECT by_person, start, end, ended_early FROM pauses WHERE start > ? ORDER BY id DESC')
        .all(new Date(now().getTime() - 48 * 3600e3).toISOString()),
      urgent: q('SELECT * FROM urgent ORDER BY id DESC LIMIT 50').all(),
      build: BUILD, topics, stand_in_coach: !!coach.STAND_IN, ai: coach.status ? coach.status() : null,
      has_passkey: !!passkeys?.hasPasskey(me.id), passkeys_available: !!passkeys,
      mute: !!q('SELECT mute FROM people WHERE id = ?').get(me.id).mute, push_key: vapidPublicKey,
      storage: files.usage(),
    };
  });

  route('POST', '/api/topics', ({ body }) => {
    const name = text(body.name, 60, 'The topic name');
    const { lastInsertRowid: id } = q('INSERT INTO topics (name, created, updated) VALUES (?, ?, ?)').run(name, iso(), iso());
    return { id: Number(id) };
  });

  route('GET', '/api/topics/:id', ({ me, params }) => {
    const t = topicOr404(params.id);
    const messages = q('SELECT id, author, created, deleted, CASE WHEN deleted = 1 THEN \'\' ELSE text END AS text FROM messages WHERE topic_id = ? ORDER BY id').all(t.id)
      .map(m => m.deleted ? m : { ...m, files: files.forMessage(m.id) });
    const other = people().find(p => p.id !== me.id);
    const seen = other ? q('SELECT message_id, at FROM topic_reads WHERE topic_id = ? AND person_id = ?').get(t.id, other.id) || null : null;
    return { topic: t, messages, card: cardFor(t.id, me), seen,
      status_request: q('SELECT by_person, to_status, checkin FROM status_requests WHERE topic_id = ?').get(t.id) || null,
      delete_request: q('SELECT by_person FROM delete_requests WHERE topic_id = ?').get(t.id) || null };
  });

  // Read receipt: the phone reports the newest message on screen. It only ever moves forward.
  route('POST', '/api/topics/:id/read', ({ me, params, body }) => {
    const t = topicOr404(params.id);
    const m = q('SELECT id FROM messages WHERE topic_id = ? AND id <= ? ORDER BY id DESC LIMIT 1').get(t.id, Number(body.message_id) || 0);
    if (!m) return { ok: true };
    q(`INSERT INTO topic_reads (topic_id, person_id, message_id, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(topic_id, person_id) DO UPDATE SET message_id = excluded.message_id, at = excluded.at WHERE excluded.message_id > topic_reads.message_id`)
      .run(t.id, me.id, m.id, iso());
    return { ok: true };
  });

  // Words of a message, plus a note like "[photo]" when something was attached. The coach and the
  // topic list only ever get this note, never the photo or file itself.
  const withFiles = m => [m.text, files.describe(m.id)].filter(Boolean).join(' ');

  // The private check. Nothing in the request is stored or logged.
  // Context for the AI coach: the current topic only, never other topics.
  function coachContext(topicId, me) {
    const topic = topicId ? q('SELECT * FROM topics WHERE id = ?').get(topicId) : null;
    return { people: people(), authorId: me.id, readerId: me.id, topic,
      messages: topic ? q('SELECT id, author, text, deleted FROM messages WHERE topic_id = ? ORDER BY id').all(topic.id)
        .map(m => m.deleted ? m : { ...m, text: withFiles(m) }) : [],
      card: topic ? cardFor(topic.id, me) : [] };
  }
  const pausedUntil = e => `Coaching is paused until ${new Date(e.until).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })} because this month's AI budget is used up.`;
  // Runs a coach call. When the coach can't answer, the check says so (the author can still send);
  // everything else gets a plain error.
  async function coached(fn, forCheck = false) {
    try { return await fn(); } catch (e) {
      if (!(e instanceof CoachUnavailable)) throw e;
      if (forCheck) return e.capped ? { kind: 'capped', message: pausedUntil(e) } : { kind: 'unavailable' };
      fail(503, e.capped ? pausedUntil(e) : "The coach didn't answer. Please try again.");
    }
  }

  route('POST', '/api/check', ({ me, body }) => {
    const draft = text(body.text, rules.MESSAGE_MAX, 'The message');
    const ctx = coachContext(Number(body.topic_id) || null, me);
    if (typeof body.clarify === 'string') {
      return coached(async () => ({ kind: 'preview', text: await coach.clarify(draft, body.clarify.slice(0, 80), ctx) }), true);
    }
    return coached(() => coach.check(draft, ctx), true);
  });

  // Help me organize this: the person's short answers, put together into one message they can send or skip.
  // Nothing is stored. If the AI can't answer, the simple version is used so the button always works.
  route('POST', '/api/organize', async ({ me, body }) => {
    const answers = [0, 1, 2, 3].map(i => typeof body.answers?.[i] === 'string' ? body.answers[i].slice(0, 300) : '');
    if (!answers.some(a => a.trim())) fail(400, 'Answer at least one question first.');
    const ctx = coachContext(Number(body.topic_id) || null, me);
    try { return await (coach.organize || stand_in.organize)(answers, ctx); } catch (e) {
      if (!(e instanceof CoachUnavailable)) throw e;
      return stand_in.organize(answers);
    }
  });

  route('POST', '/api/topics/:id/messages', ({ me, params, body }) => {
    const t = topicOr404(params.id);
    const attached = files.claimable(body.files, me);
    // A message can be just a photo or file; otherwise it needs words.
    const msg = attached.length && !String(body.text ?? '').trim() ? '' : text(body.text, rules.MESSAGE_MAX, 'The message');
    if (activePause()) fail(423, 'Conversation is paused. Your message is kept as a private draft on your phone.');
    // A retry after a slow connection brings the same files again: that message was already sent.
    const sentWith = attached.find(f => f.message_id !== null);
    if (sentWith) return { id: sentWith.message_id, duplicate: true };
    // A second tap (or a retry on a slow connection) sends the same words again within seconds:
    // that is the same message, not a new one.
    const last = q('SELECT id, text, created FROM messages WHERE topic_id = ? AND author = ? AND deleted = 0 ORDER BY id DESC LIMIT 1').get(t.id, me.id);
    if (!attached.length && last && last.text === msg && now() - new Date(last.created) < DUPLICATE_WINDOW_MS) return { id: last.id, duplicate: true };
    const { lastInsertRowid: id } = tx(db, () => {
      if (t.status === 'ok') q("UPDATE topics SET status = 'open', checkin = NULL WHERE id = ?").run(t.id);
      touch(t.id);
      const r = q('INSERT INTO messages (topic_id, author, text, created) VALUES (?, ?, ?, ?)').run(t.id, me.id, msg, iso());
      files.attach(attached, Number(r.lastInsertRowid));
      return r;
    });
    tellPartner(me, 'message', `New message in ${t.name}`);
    return { id: Number(id) };
  });

  route('POST', '/api/messages/:id/understand', ({ me, params }) => {
    const m = q('SELECT * FROM messages WHERE id = ? AND deleted = 0').get(params.id) || fail(404, 'That message was not found.');
    if (m.author === me.id) fail(400, 'Help me understand is for messages from your partner.');
    if (!m.text) fail(400, 'Help me understand works on words, and this message is only a photo or file.');
    return coached(() => coach.understand(m.text, personById(m.author).name, coachContext(m.topic_id, me)));
  });

  route('DELETE', '/api/messages/:id', ({ me, params }) => {
    const m = q('SELECT * FROM messages WHERE id = ?').get(params.id) || fail(404, 'That message was not found.');
    if (m.author !== me.id) fail(403, 'You can only delete your own messages.');
    tx(db, () => { q("UPDATE messages SET deleted = 1, text = '' WHERE id = ?").run(m.id); files.removeFor(m.id); });
    return { ok: true };
  });

  // Where we are: draft or refresh. Points both people agreed are kept as they are.
  route('POST', '/api/topics/:id/card', async ({ me, params }) => {
    const t = topicOr404(params.id);
    const msgs = q('SELECT * FROM messages WHERE topic_id = ? ORDER BY id').all(t.id).filter(m => m.deleted || m.text);
    if (!msgs.some(m => !m.deleted)) fail(400, 'There is nothing to summarize yet.');
    const drafted = await coached(() => coach.draftCard(t, msgs, people(), coachContext(t.id, me)));
    tx(db, () => {
      const old = q("SELECT id FROM card_points WHERE topic_id = ? AND label != 'agreed'").all(t.id);
      for (const p of old) { q('DELETE FROM card_confirmations WHERE point_id = ?').run(p.id); q('DELETE FROM card_points WHERE id = ?').run(p.id); }
      const agreed = new Set(q("SELECT section || '|' || text AS k FROM card_points WHERE topic_id = ?").all(t.id).map(r => r.k));
      const put = q('INSERT INTO card_points (topic_id, section, text, label, account_of, created) VALUES (?, ?, ?, ?, ?, ?)');
      for (const p of drafted) {
        if (!agreed.has(p.section + '|' + p.text)) put.run(t.id, p.section, p.text, p.label, p.account_of, iso());
      }
    });
    return { ok: true };
  });

  route('POST', '/api/card-points/:id/confirm', ({ me, params }) => {
    const p = q('SELECT * FROM card_points WHERE id = ?').get(params.id) || fail(404, 'That point was not found.');
    if (p.label !== 'draft') fail(400, 'Only draft points can be confirmed.');
    const agreed = tx(db, () => {
      q('INSERT OR IGNORE INTO card_confirmations (point_id, person_id) VALUES (?, ?)').run(p.id, me.id);
      const n = q('SELECT COUNT(*) AS n FROM card_confirmations WHERE point_id = ?').get(p.id).n;
      if (n >= 2) { q("UPDATE card_points SET label = 'agreed' WHERE id = ?").run(p.id); return true; }
      return false;
    });
    return { agreed };
  });

  // Status: "Still open" is one person's call; "Trying a fix" and "Resolved" need both.
  route('POST', '/api/topics/:id/status', ({ me, params, body }) => {
    const t = topicOr404(params.id);
    const to = body.to;
    if (!['open', 'try', 'ok'].includes(to)) fail(400, 'Unknown status.');
    if (to === 'open') {
      tx(db, () => { q("UPDATE topics SET status = 'open', checkin = NULL WHERE id = ?").run(t.id); q('DELETE FROM status_requests WHERE topic_id = ?').run(t.id); });
      return { status: 'open' };
    }
    const checkin = to === 'try' ? text(body.checkin, 40, 'The check-in') : null;
    q('INSERT OR REPLACE INTO status_requests (topic_id, by_person, to_status, checkin, created) VALUES (?, ?, ?, ?, ?)').run(t.id, me.id, to, checkin, iso());
    tellPartner(me, 'confirm', `${me.name} asked you to confirm something in ${t.name}`);
    return { pending: true };
  });

  route('POST', '/api/topics/:id/status/confirm', ({ me, params }) => {
    const t = topicOr404(params.id);
    const r = q('SELECT * FROM status_requests WHERE topic_id = ?').get(t.id) || fail(404, 'Nothing is waiting to be confirmed.');
    if (r.by_person === me.id) fail(403, 'Your partner needs to confirm this.');
    tx(db, () => { q('UPDATE topics SET status = ?, checkin = ? WHERE id = ?').run(r.to_status, r.checkin, t.id); q('DELETE FROM status_requests WHERE topic_id = ?').run(t.id); touch(t.id); });
    return { status: r.to_status };
  });

  // Deleting a whole topic (or everything, id 0) needs both people.
  function wipeTopic(id) {
    for (const p of q('SELECT id FROM card_points WHERE topic_id = ?').all(id)) q('DELETE FROM card_confirmations WHERE point_id = ?').run(p.id);
    q('DELETE FROM card_points WHERE topic_id = ?').run(id);
    q('DELETE FROM topic_reads WHERE topic_id = ?').run(id);
    for (const m of q('SELECT id FROM messages WHERE topic_id = ?').all(id)) files.removeFor(m.id);
    q('DELETE FROM messages WHERE topic_id = ?').run(id);
    q('DELETE FROM status_requests WHERE topic_id = ?').run(id);
    q('DELETE FROM topics WHERE id = ?').run(id);
  }
  route('POST', '/api/delete/:id', ({ me, params }) => {
    const id = Number(params.id);
    if (id !== 0) topicOr404(id);
    const r = q('SELECT * FROM delete_requests WHERE topic_id = ?').get(id);
    if (!r) {
      q('INSERT INTO delete_requests (topic_id, by_person, created) VALUES (?, ?, ?)').run(id, me.id, iso());
      tellPartner(me, 'confirm', `${me.name} asked you to confirm something`);
      return { pending: true };
    }
    if (r.by_person === me.id) return { pending: true };
    tx(db, () => {
      q('DELETE FROM delete_requests WHERE topic_id = ?').run(id);
      if (id === 0) {
        for (const t of q('SELECT id FROM topics').all()) wipeTopic(t.id);
        q('DELETE FROM urgent'); q('DELETE FROM pauses'); q('DELETE FROM delete_requests');
      } else wipeTopic(id);
    });
    return { deleted: true };
  });
  route('POST', '/api/delete/:id/cancel', ({ params }) => { q('DELETE FROM delete_requests WHERE topic_id = ?').run(Number(params.id)); return { ok: true }; });

  route('POST', '/api/pause', ({ me, body }) => {
    const note = body.note ? text(body.note, 80, 'The note') : null;
    return tx(db, () => {
      if (activePause()) fail(409, 'A pause is already running.');
      const start = now();
      const r = rules.resolvePauseEnd(body, start, getRules());
      if (r.error) fail(400, r.error);
      q('INSERT INTO pauses (by_person, start, end, note) VALUES (?, ?, ?, ?)').run(me.id, start.toISOString(), r.end.toISOString(), note);
      tellPartner(me, 'pause', `${me.name} asked for time to process`);
      return { end: r.end.toISOString() };
    });
  });

  route('POST', '/api/pause/end', ({ me }) => {
    const p = activePause() || fail(404, 'There is no pause running.');
    if (p.by_person !== me.id) fail(403, 'Only the person who paused can end it early.');
    q('UPDATE pauses SET ended_early = ? WHERE id = ?').run(iso(), p.id);
    q('INSERT OR IGNORE INTO notified_pauses (pause_id) VALUES (?)').run(p.id);
    tellPartner(me, 'open', 'Talking is open again');
    return { ok: true };
  });

  route('POST', '/api/urgent', ({ me, body }) => {
    if (!rules.URGENT_CATEGORIES.includes(body.category)) fail(400, 'Choose what the urgent message is about.');
    const msg = text(body.text, rules.URGENT_MAX, 'The urgent message');
    q('INSERT INTO urgent (author, category, text, created) VALUES (?, ?, ?, ?)').run(me.id, body.category, msg, iso());
    tellPartner(me, 'urgent', `Urgent message from ${me.name} (${body.category})`);
    return { ok: true };
  });

  route('POST', '/api/rules', ({ me, body }) => {
    if (body.key !== 'morning_time' && body.key !== 'tonight_time') fail(400, 'Unknown setting.');
    if (!rules.isValidClock(body.value)) fail(400, 'Use a time like 09:00.');
    q('DELETE FROM rule_requests').run();
    q('INSERT INTO rule_requests (key, value, by_person, created) VALUES (?, ?, ?, ?)').run(body.key, body.value, me.id, iso());
    tellPartner(me, 'confirm', `${me.name} asked you to confirm a settings change`);
    return { pending: true };
  });

  route('POST', '/api/rules/confirm', ({ me }) => {
    const r = q('SELECT * FROM rule_requests').get() || fail(404, 'No change is waiting.');
    if (r.by_person === me.id) fail(403, 'Your partner needs to confirm this.');
    tx(db, () => { q('UPDATE rules SET value = ? WHERE key = ?').run(r.value, r.key); q('DELETE FROM rule_requests').run(); });
    return { ok: true };
  });

  route('POST', '/api/rules/cancel', () => { q('DELETE FROM rule_requests').run(); return { ok: true }; });

  // ---------- photos, videos and files ----------
  // Uploaded as part of tapping Send, just before the message itself (drafts stay on the phone).
  route('POST', '/api/files', async ({ req, me }) => {
    if (activePause()) { req.resume(); fail(423, 'Conversation is paused. Your message is kept as a private draft on your phone.'); }
    return files.save(req, me);
  }, { raw: true });
  route('GET', '/api/files/:id', ({ req, res, me, params, query }) => { files.serve(req, res, params.id, me, query.has('download')); return HANDLED; });

  // ---------- passkeys, lock, notifications ----------
  const needPasskeys = () => passkeys || fail(501, 'Face ID sign-in is not available on this server.');
  route('GET', '/api/passkey/options', ({ me }) => needPasskeys().registrationOptions(me));
  route('POST', '/api/passkey', async ({ me, body }) => {
    if (!await needPasskeys().register(me, body.response).catch(() => false)) fail(400, 'Face ID could not be set up. Please try again.');
    return { ok: true };
  });
  route('POST', '/api/signin/options', ({ body }) => needPasskeys().authenticationOptions(text(body.key, 64, 'Key')), { auth: false });
  route('POST', '/api/signin', async ({ body, res }) => {
    const id = await needPasskeys().authenticate(text(body.key, 64, 'Key'), body.response).catch(() => null);
    if (!id) fail(401, 'That sign-in did not work. Please try again.');
    newSession(res, id);
    return { ok: true };
  }, { auth: false });
  route('POST', '/api/unlock/options', ({ me }) => needPasskeys().authenticationOptions(`unlock:${me.id}`), { locked: true });
  route('POST', '/api/unlock', async ({ me, session, body }) => {
    const id = await needPasskeys().authenticate(`unlock:${me.id}`, body.response, me.id).catch(() => null);
    if (!id) fail(401, 'That did not unlock Shlen Box. Please try again.');
    seen(session.tokenHash);
    return { ok: true };
  }, { locked: true });
  route('POST', '/api/push/subscribe', ({ me, body }) => {
    const sub = body.subscription;
    if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) fail(400, 'Notifications could not be turned on.');
    q('INSERT OR REPLACE INTO push_subscriptions (endpoint, person_id, keys, created) VALUES (?, ?, ?, ?)')
      .run(sub.endpoint, me.id, JSON.stringify({ p256dh: sub.keys.p256dh, auth: sub.keys.auth }), iso());
    return { ok: true };
  });
  route('POST', '/api/prefs', ({ me, body }) => {
    q('UPDATE people SET mute = ? WHERE id = ?').run(body.mute ? 1 : 0, me.id);
    return { ok: true };
  });

  // The AI key: pasted once by the person who set Shlen Box up. It is checked, stored on the server,
  // and never sent back to any phone.
  route('POST', '/api/ai-key', async ({ me, body }) => {
    if (!coach.setKey) fail(400, 'The AI key is set on the server itself.');
    if (me.role !== 'A') fail(403, 'Only the person who set up Shlen Box can connect the AI.');
    const key = text(body.key, 300, 'The key');
    if (!/^sk-ant-[A-Za-z0-9_-]+$/.test(key)) fail(400, "That doesn't look like an Anthropic key. It starts with sk-ant-.");
    const r = await coach.setKey(key);
    if (r === 'wrong') fail(400, 'Anthropic did not accept that key. Check that it was copied in full.');
    if (r === 'unreachable') fail(503, "Couldn't reach Anthropic to check the key. Please try again.");
    return { ok: true };
  });

  route('DELETE', '/api/ai-key', ({ me }) => {
    if (!coach.clearKey) fail(400, 'The AI key is set on the server itself.');
    if (me.role !== 'A') fail(403, 'Only the person who set up Shlen Box can disconnect the AI.');
    coach.clearKey();
    return { ok: true };
  });

  // Export: a readable text file of everything this person can see.
  route('GET', '/api/export', ({ me, res }) => {
    const names = Object.fromEntries(people().map(p => [p.id, p.id === me.id ? `${p.name} (you)` : p.name]));
    const lines = [`Shlen Box export for ${me.name}`, `Made ${iso()}`, ''];
    for (const t of q('SELECT * FROM topics ORDER BY id').all()) {
      const msgs = q('SELECT * FROM messages WHERE topic_id = ? ORDER BY id').all(t.id);
      const pts = q('SELECT * FROM card_points WHERE topic_id = ? ORDER BY id').all(t.id);
      if (!msgs.length && !pts.length) continue;
      lines.push(`== ${t.name} (${{ open: 'Still open', try: 'Trying a fix', ok: 'Resolved' }[t.status]}) ==`);
      for (const m of msgs) lines.push(`[${m.created}] ${names[m.author]}: ${m.deleted ? '(deleted)' : withFiles(m)}`);
      if (pts.length) lines.push('-- Where we are --', ...pts.map(p => `${p.section}: ${p.text} [${p.label === 'account' ? names[p.account_of] + "'s account" : p.label}]`));
      lines.push('');
    }
    const urgent = q('SELECT * FROM urgent ORDER BY id').all();
    if (urgent.length) lines.push('== Urgent ==', ...urgent.map(u => `[${u.created}] ${names[u.author]} (${u.category}): ${u.text}`));
    res.setHeader('Content-Disposition', 'attachment; filename="shlen-box-export.txt"');
    return { __text: lines.join('\n') };
  });

  // ---------- plumbing ----------
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', c => { size += c.length; if (size > BODY_LIMIT) { reject(new HttpError(413, 'That is too long.')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Could not read the request.')); }
      });
      req.on('error', reject);
    });
  }

  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  // Tell both people when a pause ends on its own. Called every minute by index.js (and directly by tests).
  function tick() {
    files.purge();
    const ended = q('SELECT p.id FROM pauses p LEFT JOIN notified_pauses n ON n.pause_id = p.id WHERE n.pause_id IS NULL AND p.ended_early IS NULL AND p.end <= ?').all(iso());
    for (const p of ended) {
      q('INSERT OR IGNORE INTO notified_pauses (pause_id) VALUES (?)').run(p.id);
      for (const person of people()) notifier.notify(person.id, 'open', 'Talking is open again');
    }
  }

  const server = http.createServer(async (req, res) => {
    const { pathname, searchParams: query } = new URL(req.url, 'http://x');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'");
    let status = 200;
    try {
      if (!pathname.startsWith('/api/')) { if (req.method !== 'GET') fail(405, 'Not allowed.'); return serveStatic(req, res, pathname); }
      const r = routes.find(r => r.method === req.method && r.re.test(pathname)) || fail(404, 'Not found.');
      const addr = clientAddr(req);
      limit('api', addr, LIMITS.apiPerMinute);
      if (!r.auth || r.locked) limit('open', addr, LIMITS.openPerMinute);
      if (req.method !== 'GET' && req.headers['x-shlen'] !== '1') fail(403, 'Request refused.'); // blocks cross-site form posts
      const session = currentSession(req);
      const me = session?.person || null;
      if (r.auth && !me) fail(401, 'Please sign in.');
      if (r.auth && session.locked && !r.locked) { status = 401; res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Shlen Box is locked.', locked: true })); }
      if (session && !session.locked) seen(session.tokenHash);
      const body = req.method === 'GET' || r.raw ? {} : await readBody(req);
      const out = await r.handler({ req, res, me, session, body, query, params: r.re.exec(pathname).groups || {} });
      if (out === HANDLED) { status = res.statusCode; return; }
      if (out && out.__text !== undefined) { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(out.__text); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out ?? {}));
    } catch (e) {
      status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log(`error ${req.method} ${pathname}: ${e.name}`); // never the message body or text
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: status === 500 ? 'Something went wrong. Please try again.' : e.message }));
    } finally {
      log(`${req.method} ${pathname} ${status}`);
    }
  });
  server.tick = tick;
  return server;
}
