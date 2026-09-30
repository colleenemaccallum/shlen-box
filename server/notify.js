// Content-free notifications (PRD F43, F44). Payloads name the topic at most, never message text.
// The actual sender is injectable so tests can check exactly what would be sent.
import webpush from 'web-push';

export function vapidKeys(db) {
  const get = k => db.prepare('SELECT value FROM secrets WHERE key = ?').get(k)?.value;
  if (!get('vapid_public')) {
    const k = webpush.generateVAPIDKeys();
    const put = db.prepare('INSERT INTO secrets (key, value) VALUES (?, ?)');
    put.run('vapid_public', k.publicKey); put.run('vapid_private', k.privateKey);
  }
  return { publicKey: get('vapid_public'), privateKey: get('vapid_private') };
}

export function webPushSender(db, subject) {
  const { publicKey, privateKey } = vapidKeys(db);
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return async (sub, payload) => {
    try { await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 3600 }); }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint);
    }
  };
}

export function createNotifier({ db, send }) {
  const q = sql => db.prepare(sql);
  // kind: 'message' | 'urgent' | 'confirm' | 'pause' | 'open'
  function notify(personId, kind, title) {
    const person = q('SELECT mute FROM people WHERE id = ?').get(personId);
    if (!person || (person.mute && kind !== 'urgent')) return [];
    const subs = q('SELECT endpoint, keys FROM push_subscriptions WHERE person_id = ?').all(personId);
    const payload = { title, kind };
    const sent = subs.map(s => ({ sub: { endpoint: s.endpoint, keys: JSON.parse(s.keys) }, payload }));
    for (const x of sent) Promise.resolve(send(x.sub, x.payload)).catch(() => {});
    return sent;
  }
  return { notify };
}
