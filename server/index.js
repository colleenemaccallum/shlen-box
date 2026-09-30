// Start Shlen Box. Settings come from environment variables:
//   SHLEN_DB    path to the database file (default ./shlen-box.db)
//   PORT        port to listen on (default 8080)
//   HOST        address to listen on (default 127.0.0.1; set to the private-network address in production)
//   ORIGIN      the address phones use, e.g. https://shlen-box.example.ts.net (default http://localhost:PORT)
//   SECURE      set to 1 when served over HTTPS so cookies are marked Secure
//   CONTACT     an email for the notification services (default mailto:admin@localhost)
//   ANTHROPIC_API_KEY  the AI key (optional: it can instead be pasted once in Settings). Without a key the stand-in coach is used.
//   AI_CAP_USD  the monthly AI spending cap in dollars (default 10)
import { openDb } from './db.js';
import { createApp } from './app.js';
import { createPasskeys } from './passkeys.js';
import { createNotifier, webPushSender, vapidKeys } from './notify.js';
import { createCoachSwitch } from './coach-switch.js';

const port = Number(process.env.PORT || 8080), host = process.env.HOST || '127.0.0.1';
const origin = process.env.ORIGIN || `http://localhost:${port}`;
const now = () => new Date();
const db = openDb(process.env.SHLEN_DB || 'shlen-box.db');

const coach = createCoachSwitch({ db, now, envKey: process.env.ANTHROPIC_API_KEY || null, capUsd: Number(process.env.AI_CAP_USD || 10) });

const app = createApp({
  db, now, coach,
  secureCookies: process.env.SECURE === '1',
  passkeys: createPasskeys({ db, rpID: new URL(origin).hostname, origin, now }),
  notifier: createNotifier({ db, send: webPushSender(db, process.env.CONTACT || 'mailto:admin@localhost') }),
  vapidPublicKey: vapidKeys(db).publicKey,
  log: line => console.log(`${new Date().toISOString()} ${line}`),
});
setInterval(() => app.tick(), 60e3).unref();
app.listen(port, host, () => console.log(`Shlen Box running at http://${host}:${port} (phones use ${origin}), coach: ${coach.STAND_IN ? 'stand-in' : 'AI'}`));
