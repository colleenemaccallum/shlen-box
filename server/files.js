// Photos, videos and files sent in messages. Each one is saved on the server's disk under a random
// name, next to the database, and is only ever handed to one of the two signed-in people.
// The coach never sees them: it reads only the words of a message.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

export const FILE_MAX = 50 * 1024 * 1024;     // per file: a photo, or a short video (about a minute)
export const FILES_PER_MESSAGE = 6;
export const KEEP_FREE = 3 * 1024 ** 3;        // uploads stop before the server's disk gets this full
export const KEEP_REMOVED_DAYS = 14;           // same as the nightly database copies
export const ABANDONED_MS = 3600e3;            // an upload whose message never arrived

// Shown in the conversation. Everything else is offered as a download, never opened in the app.
const IMAGES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif'];
const VIDEOS = ['video/mp4', 'video/quicktime', 'video/webm'];
export const kindOf = type => IMAGES.includes(type) ? 'image' : VIDEOS.includes(type) ? 'video' : 'file';

const safeType = t => typeof t === 'string' && /^[a-z]+\/[a-z0-9.+-]+$/i.test(t) && t.length < 100 ? t.toLowerCase() : 'application/octet-stream';
const safeName = n => (typeof n === 'string' ? n : '').replace(/[\u0000-\u001f\u007f/\\]/g, '').trim().slice(0, 120) || 'file';

export function createFiles({ db, dir, now, fail }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const q = sql => db.prepare(sql);
  const where = id => path.join(dir, id);

  function freeBytes() {
    try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return Infinity; }
  }

  // Streams one upload to disk. The body is the file itself; its name comes in a header.
  async function save(req, me) {
    const declared = Number(req.headers['content-length']);
    if (declared > FILE_MAX) { req.resume(); fail(413, 'That file is too big. Photos and videos can be up to 50 MB (about a minute of video).'); }
    if (freeBytes() - (declared || FILE_MAX) < KEEP_FREE) { req.resume(); fail(507, "Shlen Box's storage is almost full, so new photos and files can't be added."); }
    let name = 'file'; try { name = safeName(decodeURIComponent(req.headers['x-name'] || '')); } catch {}
    const type = safeType(req.headers['content-type']);
    const id = crypto.randomBytes(16).toString('hex');
    const part = where(id) + '.part';
    let size = 0;
    const count = new Transform({ transform(c, _, done) {
      size += c.length;
      done(size > FILE_MAX ? Object.assign(new Error('too big'), { tooBig: true }) : null, c);
    } });
    try { await pipeline(req, count, fs.createWriteStream(part, { mode: 0o600 })); } catch (e) {
      fs.rmSync(part, { force: true });
      if (e.tooBig) fail(413, 'That file is too big. Photos and videos can be up to 50 MB (about a minute of video).');
      throw e;
    }
    if (!size) { fs.rmSync(part, { force: true }); fail(400, 'That file is empty.'); }
    fs.renameSync(part, where(id));
    q('INSERT INTO files (id, owner, name, type, size, created) VALUES (?, ?, ?, ?, ?, ?)').run(id, me.id, name, type, size, now().toISOString());
    return { id, kind: kindOf(type) };
  }

  // Files ready to go out with a message: uploaded by this person, not yet sent.
  function claimable(ids, me) {
    if (ids === undefined) return [];
    if (!Array.isArray(ids) || ids.length > FILES_PER_MESSAGE) fail(400, `Up to ${FILES_PER_MESSAGE} photos or files can go in one message.`);
    return [...new Set(ids.map(String))].map(id => q('SELECT * FROM files WHERE id = ? AND owner = ? AND removed IS NULL').get(id, me.id)
      || fail(400, 'A photo or file didn\'t finish uploading. Please try sending again.'));
  }
  const attach = (rows, messageId) => { for (const f of rows) q('UPDATE files SET message_id = ? WHERE id = ?').run(messageId, f.id); };

  const forMessage = id => q('SELECT id, name, type, size FROM files WHERE message_id = ? AND removed IS NULL ORDER BY rowid').all(id)
    .map(f => ({ ...f, kind: kindOf(f.type) }));
  // A few words for places that show only text (the topic list, the coach, the export).
  function describe(messageId) {
    const fs_ = forMessage(messageId);
    if (!fs_.length) return '';
    const kinds = new Set(fs_.map(f => f.kind));
    const word = kinds.size > 1 ? 'attachment' : { image: 'photo', video: 'video', file: 'file' }[[...kinds][0]];
    return fs_.length === 1 ? `[${word}]` : `[${fs_.length} ${word}s]`;
  }
  const removeFor = messageId => q('UPDATE files SET removed = ? WHERE message_id = ? AND removed IS NULL').run(now().toISOString(), messageId);

  // Sends one file to a signed-in person, with byte ranges so phones can play videos.
  function serve(req, res, id, me, download) {
    const f = q('SELECT * FROM files WHERE id = ? AND removed IS NULL').get(id);
    if (!f || (f.message_id === null && f.owner !== me.id) || !fs.existsSync(where(f.id))) fail(404, 'That file was not found.');
    const kind = kindOf(f.type), inline = kind !== 'file' && !download;
    const headers = {
      'Content-Type': inline ? f.type : 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      'Cache-Control': 'private, max-age=31536000, immutable', 'Accept-Ranges': 'bytes',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    let start = 0, end = f.size - 1, status = 200;
    if (m && (m[1] || m[2])) {
      start = m[1] ? Number(m[1]) : Math.max(0, f.size - Number(m[2]));
      end = m[1] && m[2] ? Math.min(Number(m[2]), f.size - 1) : f.size - 1;
      if (start > end || start >= f.size) { res.writeHead(416, { 'Content-Range': `bytes */${f.size}` }); return res.end(); }
      status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${f.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(where(f.id), { start, end }).pipe(res);
  }

  // Called by the minute timer: deletes files whose message was deleted long enough ago that no
  // nightly copy still refers to them, and uploads that never became a message.
  function purge() {
    const t = now().getTime();
    const old = q('SELECT id FROM files WHERE (removed IS NOT NULL AND removed < ?) OR (message_id IS NULL AND created < ?)')
      .all(new Date(t - KEEP_REMOVED_DAYS * 86400e3).toISOString(), new Date(t - ABANDONED_MS).toISOString());
    for (const f of old) { fs.rmSync(where(f.id), { force: true }); q('DELETE FROM files WHERE id = ?').run(f.id); }
  }

  const usage = () => ({ used: q('SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE removed IS NULL').get().n, free: freeBytes() });

  return { save, claimable, attach, forMessage, describe, removeFor, serve, purge, usage };
}
