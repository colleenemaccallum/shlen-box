// Shlen Box phone app. Drafts are kept only in this phone's storage (localStorage) and never sent to be stored.
// Text boxes only ever hold what the person typed (decision D11): suggestions stay in the review panel.

import { passkeysSupported, createPasskey, usePasskey, urlB64ToUint8 } from './webauthn.js';

const $app = document.getElementById('app');
const $layer = document.getElementById('layer');
const $toast = document.getElementById('toast');

const S = { data: null, screen: 'home', topicId: null, topic: null, pending: null, urgentCat: null, error: null, picked: {} };
const STATUS = { open: 'Still open', try: 'Trying a fix', ok: 'Resolved' };
const URGENT = ['Safety', 'Health', 'Kids & pickups', 'Home emergency', 'Time-sensitive plans'];

// ---------- utilities ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = iso => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const dayClock = iso => new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const me = () => S.data.me;
const partner = () => S.data.partner;
const nameOf = id => id === me().id ? 'You' : (partner()?.id === id ? partner().name : 'Someone');
const pause = () => S.data?.pause && new Date(S.data.pause.end) > new Date() ? S.data.pause : null;

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-shlen': '1' },
    body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  const type = res.headers.get('content-type') || '';
  const out = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw Object.assign(new Error(out.error || 'Something went wrong.'), { status: res.status, locked: !!out.locked });
  return out;
}

const FILE_MAX = 50 * 1024 * 1024, FILES_PER_MESSAGE = 6;
const size = n => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;

// Photos, videos and files picked for the next message. Like drafts, they stay on this phone
// (in memory, while the app is open) and only go to the server when Send is tapped.
const pickedFor = id => S.picked[id] || (S.picked[id] = []);
function clearPicked(id) { for (const p of pickedFor(id)) if (p.url) URL.revokeObjectURL(p.url); S.picked[id] = []; }
function pick(fileList) {
  const list = pickedFor(S.topicId);
  for (const file of fileList) {
    if (list.length >= FILES_PER_MESSAGE) { toast(`Up to ${FILES_PER_MESSAGE} photos or files can go in one message.`); break; }
    if (file.size > FILE_MAX) { toast(`“${file.name}” is too big. Photos and videos can be up to 50 MB (about a minute of video).`); continue; }
    list.push({ file, url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null, id: null });
  }
  render();
}
async function upload(file) {
  const res = await fetch('/api/files', { method: 'POST', credentials: 'same-origin', body: file,
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-name': encodeURIComponent(file.name || 'file'), 'x-shlen': '1' } });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(out.error || "A photo or file couldn't be sent. Please try again."), { status: res.status, locked: !!out.locked });
  return out;
}

const draftKey = topicId => `shlen:draft:${me().id}:${topicId}`;
const getDraft = id => { try { return localStorage.getItem(draftKey(id)) || ''; } catch { return ''; } };
const setDraft = (id, v) => { try { v.trim() ? localStorage.setItem(draftKey(id), v) : localStorage.removeItem(draftKey(id)); } catch {} };

let toastTimer;
function toast(msg) { $toast.textContent = msg; $toast.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $toast.hidden = true; }, 3500); }

// A short buzz so a tap is felt. Android: vibrate. iPhone Safari has no vibrate and ignores switches
// toggled by code, so an invisible native switch is laid over the button: the finger's own tap flips
// it, which gives the system tap feel (iOS 18+), and the tap still reaches the button.
// Adapted from ios-haptics by tijn.dev (MIT).
const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function buzz() { try { if (!IOS) navigator.vibrate?.(15); } catch {} }
function hapticTrigger(el) {
  if (!IOS || !el || el.querySelector('[data-haptic]')) return;
  const s = document.createElement('input');
  s.type = 'checkbox'; s.setAttribute('switch', ''); s.setAttribute('data-haptic', ''); s.setAttribute('aria-hidden', 'true'); s.tabIndex = -1;
  Object.assign(s.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', margin: '0', opacity: '0', clipPath: 'inset(0 round 999px)', touchAction: 'pan-x pan-y' });
  s.style.setProperty('-webkit-tap-highlight-color', 'transparent');
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
  el.append(s);
}
// Every button gets the tap feel, wherever it appears (screens, panels, sheets). On iPhone links are
// left out: a switch inside a link would take the tap and the link wouldn't open.
const TAPPABLE = 'button, a.btn';
if (IOS) {
  const add = root => root.querySelectorAll?.('button').forEach(hapticTrigger);
  new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if (n.matches?.('button')) hapticTrigger(n); add(n); })))
    .observe(document.documentElement, { childList: true, subtree: true });
  add(document);
} else {
  document.addEventListener('click', e => { if (e.target.closest?.(TAPPABLE) && !e.target.closest('button:disabled')) buzz(); }, true);
}

// Shows a button as working (label, or null to restore it to `idle`) so a slow answer can't be tapped twice.
function busy(b, label, idle) {
  if (!b) return;
  b.disabled = !!label;
  b.textContent = label || idle || b.textContent;
  hapticTrigger(b);
}

function openSheet(html, handlers = {}) {
  $layer.innerHTML = `<div class="sheetwrap" data-close="1"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  $layer.querySelector('.sheetwrap').addEventListener('click', e => { if (e.target.dataset.close) closeSheet(); });
  $layer.querySelectorAll('[data-s]').forEach(b => b.addEventListener('click', () => handlers[b.dataset.s]?.(b)));
  $layer.querySelectorAll('.btn.pri').forEach(hapticTrigger);
  $layer.querySelector('button, input')?.focus();
}
const closeSheet = () => { $layer.innerHTML = ''; };
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $layer.innerHTML) closeSheet(); });

// ---------- loading ----------
async function load() {
  try {
    S.data = await api('GET', '/api/state');
    if (S.screen === 'topic' || S.screen === 'card') S.topic = await api('GET', `/api/topics/${S.topicId}`);
    markRead();
  } catch (e) {
    if (e.locked) return renderLocked();
    if (e.status === 401) { S.data = null; return renderWelcome(); }
    S.error = "Shlen Box can't be reached right now. Your drafts are safe on this phone. For anything urgent, call or text.";
  }
  render();
}

async function go(screen, topicId) {
  S.screen = screen; if (topicId !== undefined) S.topicId = topicId;
  closeSheet(); await load(); window.scrollTo(0, 0);
}

// Tells the server which messages are on screen, for the other person's "Seen". Only while the
// conversation is actually showing, and only when there is something new from them.
function markRead() {
  if (S.screen !== 'topic' || document.hidden || !S.topic) return;
  const last = S.topic.messages.at(-1);
  if (!last || last.id === S.readSent) return;
  S.readSent = last.id;
  api('POST', `/api/topics/${S.topicId}/read`, { message_id: last.id }).catch(() => { S.readSent = null; });
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.data) load(); });

// Refresh quietly while the app is open, without disturbing typing or an open panel.
setInterval(() => {
  if (document.hidden || !S.data || $layer.innerHTML || sending) return;
  if ([...document.querySelectorAll('video')].some(v => !v.paused)) return; // don't stop a video that's playing
  const a = document.activeElement;
  if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')) return;
  load();
}, 8000);

// ---------- welcome: set up or join ----------
async function renderWelcome() {
  const { people } = await api('GET', '/api/setup');
  $app.innerHTML = `<h1>Shlen Box</h1>
    <p class="muted">A private place for the two of you.</p>
    ${people === 0 ? `
      <h2>Set up</h2>
      <label for="name" class="k">Your first name</label><input type="text" id="name" maxlength="40" autocomplete="given-name">
      <button class="btn pri" id="go">Set up Shlen Box</button>`
    : people === 1 ? `
      <h2>Join your partner</h2>
      <label for="name" class="k">Your first name</label><input type="text" id="name" maxlength="40" autocomplete="given-name">
      <label for="code" class="k">Code from your partner</label><input type="text" id="code" maxlength="12" autocapitalize="characters" autocomplete="off">
      <button class="btn pri" id="go">Join</button>`
    : `<p>Shlen Box is set up for two people.</p>`}
    ${people > 0 && passkeysSupported() ? `<button class="btn ${people === 2 ? 'pri' : 'quiet'}" id="signin">Sign in with Face ID or fingerprint</button>` : ''}
    <p class="error" id="err"></p>`;
  document.getElementById('signin')?.addEventListener('click', async () => {
    try {
      const key = crypto.randomUUID();
      const opts = await api('POST', '/api/signin/options', { key });
      await api('POST', '/api/signin', { key, response: await usePasskey(opts) });
      S.screen = 'home'; load();
    } catch (e) { document.getElementById('err').textContent = e.status ? e.message : 'Sign-in was cancelled.'; }
  });
  document.getElementById('go')?.addEventListener('click', async () => {
    const name = document.getElementById('name').value;
    try {
      if (people === 0) await api('POST', '/api/setup', { name });
      else await api('POST', '/api/join', { name, code: document.getElementById('code').value });
      S.screen = 'home'; load();
    } catch (e) { document.getElementById('err').textContent = e.message; }
  });
}

function renderLocked() {
  closeSheet(); S.data = null;
  $app.innerHTML = `<h1>Shlen Box</h1><p>Locked to keep things private.</p>
    <button class="btn pri" id="unlock">Unlock with Face ID or fingerprint</button>
    <p class="error" id="err"></p><div class="spacer"></div><button class="btn quiet" id="out">Sign out on this phone</button>`;
  document.getElementById('unlock').onclick = async () => {
    try { const o = await api('POST', '/api/unlock/options'); await api('POST', '/api/unlock', { response: await usePasskey(o) }); load(); }
    catch (e) { document.getElementById('err').textContent = e.status ? e.message : 'Unlock was cancelled.'; }
  };
  document.getElementById('out').onclick = async () => { await api('POST', '/api/logout'); S.data = null; renderWelcome(); };
}

async function setupPasskey() {
  try { const o = await api('GET', '/api/passkey/options'); await api('POST', '/api/passkey', { response: await createPasskey(o) }); toast('Face ID sign-in is on.'); }
  catch (e) { toast(e.status ? e.message : 'Face ID setup was cancelled.'); }
  load();
}

async function enableNotifications() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('This phone can’t get notifications from Shlen Box. On iPhone, add it to your Home Screen first.');
    if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications were not allowed.');
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(S.data.push_key) });
    await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
    toast('Notifications are on. They never show message text.');
  } catch (e) { toast(e.message); }
}

// ---------- screens ----------
const BRAND = '<span class="brand"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="9" cy="12" r="6.5"/><circle cx="15" cy="12" r="6.5"/></svg>Shlen Box</span>';
function render() {
  if (S.error) { $app.innerHTML = `<h1>Shlen Box</h1><p class="error">${esc(S.error)}</p><button class="btn" id="retry">Try again</button>`;
    document.getElementById('retry').onclick = () => { S.error = null; load(); }; return; }
  if (!S.data) return;
  const view = { home, topic: topicView, card: cardView, pause: pauseView, urgent: urgentView, settings }[S.screen] || home;
  $app.innerHTML = view();
  // The pause screen tints the whole home screen.
  document.body.classList.toggle('paused', view === home && !!S.data.partner && !!pause());
  bind();
}

function pill(t) {
  return `<span class="pill ${t.status}">${STATUS[t.status]}</span>${t.status === 'try' && t.checkin ? ` <span class="small muted">check-in ${esc(t.checkin)}</span>` : ''}`;
}

function stateLine() {
  const p = pause();
  return p ? `<div class="stateline"><span class="dot paused" aria-hidden="true"></span>Paused by ${p.by_person === me().id ? 'you' : esc(partner().name)} until ${clock(p.end)}</div>`
           : `<div class="stateline"><span class="dot" aria-hidden="true"></span>Talking is open</div>`;
}

function pauseBanner() {
  const p = pause(); if (!p) return '';
  const mine = p.by_person === me().id, mins = Math.max(1, Math.round((new Date(p.end) - new Date()) / 60000));
  const left = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
  return `<div class="pausebox" role="status">
    <div><b>${mine ? 'You asked for time to process.' : `${esc(partner().name)} asked for time to process.`}</b></div>
    <div class="small muted">Paused at ${clock(p.start)}${p.note ? ` · “${esc(p.note)}”` : ''}</div>
    <div class="time">${clock(p.end)}</div>
    <div class="small">Talking reopens then, in ${left}.</div>
    <div class="small muted">Urgent logistics stays open. You can still write private drafts.</div>
    ${mine ? '<button class="btn" data-act="endpause">I\'m ready to talk now</button>' : ''}</div>`;
}

// Home during a pause: breathe while you wait.
function pauseCalm() {
  const p = pause(), mine = p.by_person === me().id, mins = Math.max(1, Math.round((new Date(p.end) - new Date()) / 60000));
  const left = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
  return `<div class="calm" role="status">
    <div class="breath" aria-hidden="true"></div>
    <p class="small">Breathe in as it grows, out as it shrinks.</p>
    <p><b>${mine ? 'You asked for time to process.' : `${esc(partner().name)} asked for time to process.`}</b></p>
    ${p.note ? `<p class="small muted">“${esc(p.note)}”</p>` : ''}
    <div class="time">${clock(p.end)}</div>
    <p class="small">Talking reopens then, in ${left}. Urgent logistics stays open, and you can still write private drafts.</p>
    <button class="btn warn" data-act="urgent">Urgent logistics</button>
    ${mine ? '<button class="btn quiet" data-act="endpause">I\'m ready to talk now</button>' : ''}</div>`;
}

function home() {
  const d = S.data;
  if (!d.partner) return `<h1>Shlen Box</h1>
    <p>Almost ready. Give your partner this code so they can join from their phone:</p>
    <div class="code" aria-label="Invite code">${esc(d.invite || '')}</div>
    <p class="small muted">They open this same address on their phone and choose Join. Once they've joined, no one else can.</p>
    <button class="btn" data-act="refresh">They've joined</button>
    <button class="btn quiet" data-act="settings">Settings</button>`;
  const topics = d.topics.map(t => {
    const draft = getDraft(t.id);
    const last = t.last;
    return `<button class="topic" data-topic="${t.id}"><b>${esc(t.name)}</b>
      <span class="row">${pill(t)}${draft ? '<span class="draftnote">Draft saved</span>' : ''}${t.status_request && t.status_request.by_person !== me().id ? '<span class="draftnote">Waiting for you to confirm</span>' : ''}</span>
      ${last ? `<span class="small muted">${nameOf(last.author)}: ${last.deleted ? 'Message deleted' : esc(last.text.slice(0, 60)) + (last.text.length > 60 ? '…' : '')}</span>` : '<span class="small muted">Nothing here yet</span>'}</button>`;
  }).join('');
  const recent = d.urgent.filter(u => new Date() - new Date(u.created) < 24 * 3600e3);
  return `<div class="top"><h1>${BRAND}</h1><button class="iconbtn" data-act="settings">Settings</button></div>
    ${d.stand_in_coach ? '<p class="banner">Test version: the coach is a simple stand-in, not the real AI yet.</p>' : ''}
    ${d.passkeys_available && !d.has_passkey && passkeysSupported() ? '<button class="btn" data-act="passkey">Turn on Face ID or fingerprint sign-in</button>' : ''}
    ${pause() ? pauseCalm() : stateLine()}
    ${recent.length ? `<button class="btn warn" data-act="urgent">Urgent messages (${recent.length} today)</button>` : ''}
    <div class="list">${topics}</div>
    <button class="btn quiet" data-act="newtopic">+ New topic</button>
    <div class="spacer"></div>
    ${pause() ? ''
      : '<div class="row2"><button class="btn" data-act="pause">Take a break</button><button class="btn pri" data-act="write">Write something</button></div>'}`;
}

const fileUrl = (f, save) => `/api/files/${encodeURIComponent(f.id)}${save ? '?download' : ''}`;
function attachments(m) {
  return (m.files || []).map(f => f.kind === 'image'
    ? `<button class="att-img" data-view="${esc(f.id)}" aria-label="Open photo"><img src="${fileUrl(f)}" alt="Photo" loading="lazy"></button>`
    : f.kind === 'video'
    ? `<video class="att-vid" src="${fileUrl(f)}" controls playsinline preload="metadata"></video><a class="linkbtn" href="${fileUrl(f, true)}" download="${esc(f.name)}">Save video</a>`
    : `<a class="att-file" href="${fileUrl(f, true)}" download="${esc(f.name)}"><b>${esc(f.name)}</b><span class="small muted">${size(f.size)} · Download</span></a>`).join('');
}

function pickedView() {
  const list = pickedFor(S.topicId);
  if (!list.length) return '';
  return `<div class="picked">${list.map((p, i) => `<div class="att-chip">
    ${p.url ? `<img src="${p.url}" alt="">` : `<span class="att-ico">${p.file.type.startsWith('video/') ? 'Video' : 'File'}</span>`}
    <span class="small">${esc(p.file.name)} · ${size(p.file.size)}</span>
    <button class="linkbtn" data-unpick="${i}" aria-label="Remove ${esc(p.file.name)}">Remove</button></div>`).join('')}</div>`;
}

function topicView() {
  const { topic: t, messages, status_request: sr, seen } = S.topic;
  // Under your newest message: "Seen" with the time once the other person has had it on screen, otherwise "Sent".
  const myLast = [...messages].reverse().find(m => m.author === me().id && !m.deleted);
  const receipt = m => m !== myLast ? '' : `<div class="receipt">${seen && seen.message_id >= m.id ? `Seen ${clock(seen.at)}` : 'Sent'}</div>`;
  const msgs = messages.map(m => {
    const mine = m.author === me().id;
    if (m.deleted) return `<div class="msg ${mine ? 'me' : ''}"><span class="who">${nameOf(m.author)}</span><span class="deleted">Message deleted</span></div>`;
    return `<div class="msg ${mine ? 'me' : ''}"><span class="who">${nameOf(m.author)} · ${clock(m.created)}</span>${attachments(m)}${m.text ? `<span>${esc(m.text)}</span>` : ''}
      ${mine ? `<button class="linkbtn" data-del="${m.id}">Delete</button>` : m.text ? `<button class="linkbtn" data-help="${m.id}">Help me understand</button>` : ''}</div>${receipt(m)}`;
  }).join('');
  return `<div class="top"><button class="iconbtn" data-act="home">‹ Topics</button><span>${pill(t)}</span></div>
    <h2>${esc(t.name)}</h2>
    ${pauseBanner()}
    ${sr && sr.by_person !== me().id ? `<p class="note">${esc(partner().name)} asked to mark this “${STATUS[sr.to_status]}”. Open Where we are to confirm.</p>` : ''}
    <button class="btn" data-act="card">${S.topic.card.length ? 'Where we are' : 'Where are we?'}</button>
    <div class="msgs">${msgs || '<p class="muted">No messages yet.</p>'}</div>
    <div class="spacer"></div>
    <div class="composer"><span class="privtag">Private draft · only you see this</span>
      <label for="draft" class="small muted">Write it the way you actually feel it. Only your own words go in this box.</label>
      <textarea id="draft" maxlength="5000">${esc(getDraft(t.id))}</textarea>
      ${pickedView()}
      <input type="file" id="pick" multiple hidden>
      <button class="btn quiet" data-act="pick">+ Photo, video or file</button>
      <div class="row2"><button class="btn quiet" data-act="organize">Help me organize this</button>
      <button class="btn pri" data-act="send">${pause() ? 'Keep as draft' : 'Send'}</button></div>
    </div>`;
}

function cardView() {
  const { topic: t, card, status_request: sr, delete_request: dr } = S.topic;
  const label = p => p.label === 'agreed' ? '<span class="lbl agreed">✓ Agreed by both</span>'
    : p.label === 'account' ? `<span class="lbl account">${p.account_of === me().id ? 'Your' : esc(partner().name) + '’s'} account</span>`
    : `<span class="lbl draft">Draft, not agreed yet${p.confirmed_by.length ? (p.confirmed_by.includes(me().id) ? ' · you confirmed' : ` · ${esc(partner().name)} confirmed`) : ''}</span>`;
  const pts = card.map(p => `<div class="pt ${p.label}"><span class="k">${esc(p.section)}</span>${label(p)}<span>${esc(p.text)}</span>
    ${p.label === 'draft' && !p.confirmed_by.includes(me().id) ? `<button class="confirm" data-conf="${p.id}">This is right</button>` : ''}</div>`).join('');
  let status;
  if (sr) status = sr.by_person === me().id
    ? `<p class="note">You asked to mark this “${STATUS[sr.to_status]}”${sr.checkin ? ` with a check-in ${esc(sr.checkin)}` : ''}. Waiting for ${esc(partner().name)} to confirm.</p>`
    : `<p class="note">${esc(partner().name)} asked to mark this “${STATUS[sr.to_status]}”${sr.checkin ? ` with a check-in ${esc(sr.checkin)}` : ''}.</p><button class="btn pri" data-act="confstatus">Confirm</button>`;
  else status = `<div class="row3">${['open', 'try', 'ok'].filter(s => s !== t.status).map(s => `<button class="btn" data-status="${s}">${STATUS[s]}</button>`).join('')}</div>`;
  const del = dr ? (dr.by_person === me().id ? `<p class="note">You asked to delete this whole topic. Waiting for ${esc(partner().name)}.</p><button class="btn quiet" data-act="canceldel">Cancel</button>`
      : `<p class="note">${esc(partner().name)} asked to delete this whole topic and all its messages.</p><button class="btn warn" data-act="deltopic">Delete for both of us</button>`)
    : '<button class="btn quiet" data-act="deltopic">Delete this whole topic…</button>';
  return `<div class="top"><button class="iconbtn" data-act="topic">‹ Messages</button><span>${pill(t)}</span></div>
    <h2>Where we are: ${esc(t.name)}</h2>
    <p class="small muted">Drafted from what you both actually wrote. A point only counts as agreed when both of you confirm it.</p>
    ${card.length ? `<div class="tl">${pts}</div>` : '<p class="muted">No summary yet.</p>'}
    <button class="btn" data-act="refreshcard">${card.length ? 'Refresh from new messages' : 'Draft a summary'}</button>
    <span class="k">Status</span>${status}
    <span class="k">Topic</span>${del}`;
}

function pauseView() {
  const lim = S.data.pause_limits;
  const opts = [['15 min', { minutes: 15 }], ['30 min', { minutes: 30 }], ['1 hour', { minutes: 60 }],
    ['Until tonight', { until: 'tonight' }, lim.tonight], ['Until morning', { until: 'morning' }, lim.morning]];
  const recentMine = S.data.pauses_recent.filter(p => p.by_person === me().id).length;
  return `<div class="top"><button class="iconbtn" data-act="home">‹ Back</button></div>
    <h2>Take a break</h2><p>How long do you need? Talking reopens by itself at the time you pick.</p>
    ${recentMine >= 3 ? '<p class="note">You’ve paused a few times in the last two days. It might help to pick a set time to talk instead.</p>' : ''}
    <div class="list">${opts.map(([l, spec, end]) => {
      const ok = !end || new Date(end) <= new Date(lim.morning);
      return ok ? `<button class="btn choice" data-pause='${JSON.stringify(spec)}'><span>${l}</span><span class="muted small">${end ? dayClock(end) : ''}</span></button>` : '';
    }).join('')}</div>
    <label for="pnote" class="small muted">Optional note for ${esc(partner().name)}</label>
    <input type="text" id="pnote" maxlength="80">
    <p class="note">${esc(partner().name)} will see that you paused and when talking reopens, but not why unless you add a note. The longest a pause can last is until ${dayClock(lim.morning)}. Urgent logistics stays open for both of you.</p>`;
}

function urgentView() {
  return `<div class="top"><button class="iconbtn" data-act="home">‹ Back</button></div>
    <h2>Urgent logistics</h2>
    <p class="note">For a real emergency, call 911. If Shlen Box can't be reached, call or text.</p>
    <span class="k">What is it about?</span>
    <div class="cats" role="group" aria-label="Category">${URGENT.map(c => `<button class="btn small" data-cat="${esc(c)}" aria-pressed="${S.urgentCat === c}">${esc(c)}</button>`).join('')}</div>
    <label for="utext" class="k">Message (short)</label>
    <input type="text" id="utext" maxlength="280">
    <p class="small muted">Urgent messages skip the check and send right away. Both of you can always see every urgent message.</p>
    <button class="btn warn" data-act="sendurgent">Send urgent message</button>
    ${S.data.urgent.length ? `<span class="k">Urgent messages (${S.data.urgent.length})</span>` + S.data.urgent.map(u =>
      `<div class="msg ${u.author === me().id ? 'me' : ''} urgent"><span class="who">Urgent · ${esc(u.category)} · ${nameOf(u.author)} · ${dayClock(u.created)}</span>${esc(u.text)}</div>`).join('') : ''}`;
}

const partnerName = () => partner()?.name || 'your partner';

function aiSection(d) {
  if (!d.ai) return '';
  const used = `<p class="small muted">AI used this month: $${d.ai.spent.toFixed(2)} of $${d.ai.cap}. Coaching pauses at the limit and your messages can still be sent.</p>`;
  if (d.ai.connected) return `<span class="k">AI coach</span><p class="small muted">Connected.</p>${used}
    ${d.ai.from_settings && me().role === 'A' ? '<button class="btn quiet" data-act="aioff">Disconnect the AI</button>' : ''}`;
  if (me().role !== 'A') return `<span class="k">AI coach</span><p class="small muted">Not connected yet. ${esc(partner()?.name || 'Your partner')} can connect it.</p>`;
  return `<span class="k">AI coach</span>
    <label for="aikey" class="small muted">Paste your Anthropic key to turn on the real coach. It is kept on the server and never shown again.</label>
    <div class="row2"><input type="password" id="aikey" autocomplete="off" spellcheck="false"><button class="btn" data-act="aikey">Connect</button></div>`;
}

function settings() {
  const d = S.data, rr = d.rule_request, wr = d.wipe_request;
  const ruleName = { morning_time: 'Morning time', tonight_time: 'Tonight time' };
  const req = rr ? (rr.by_person === me().id
      ? `<p class="note">You asked to change ${ruleName[rr.key].toLowerCase()} to ${esc(rr.value)}. Waiting for ${esc(partnerName())}.</p><button class="btn quiet" data-act="cancelrule">Cancel</button>`
      : `<p class="note">${esc(partnerName())} asked to change ${ruleName[rr.key].toLowerCase()} to ${esc(rr.value)}.</p><button class="btn pri" data-act="confrule">Confirm change</button>`)
    : `<label for="morning" class="small muted">Suggest a new morning time</label><div class="row2"><input type="time" id="morning" value="${esc(d.rules.morning_time)}"><button class="btn" data-act="suggestrule">Suggest</button></div>`;
  const wipe = wr ? (wr.by_person === me().id
      ? `<p class="note">You asked to delete everything. Waiting for ${esc(partnerName())}.</p><button class="btn quiet" data-act="cancelwipe">Cancel</button>`
      : `<p class="note">${esc(partnerName())} asked to permanently delete everything in Shlen Box.</p><button class="btn warn" data-act="wipe">Delete everything for both of us</button>`)
    : '<button class="btn quiet" data-act="wipe">Delete everything…</button>';
  return `<div class="top"><button class="iconbtn" data-act="home">‹ Back</button></div>
    <h2>Settings</h2>
    ${d.partner ? '' : `<p class="note">Your partner hasn't joined yet. Shared rules and deleting everything appear once they have.</p>`}
    ${d.partner ? `<span class="k">Shared rules · changes need both of you</span>
    <div class="card"><div class="pt"><span>Morning time (latest a pause can last)</span><b>${esc(d.rules.morning_time)}</b></div>
      <div class="pt"><span>Tonight time (for “Until tonight”)</span><b>${esc(d.rules.tonight_time)}</b></div></div>
    ${req}` : ''}
    <span class="k">This phone</span>
    ${d.passkeys_available && !d.has_passkey ? '<button class="btn" data-act="passkey">Turn on Face ID or fingerprint sign-in</button>' : d.has_passkey ? '<p class="small muted">Face ID or fingerprint sign-in is on. Shlen Box locks after 5 minutes away.</p>' : ''}
    ${d.push_key ? '<button class="btn" data-act="notify">Turn on notifications</button>' : ''}
    <button class="btn" data-act="mute" aria-pressed="${d.mute}">${d.mute ? 'Only urgent notifications (tap to get all)' : 'All notifications (tap for urgent only)'}</button>
    ${aiSection(d)}
    <span class="k">Your data</span>
    ${d.storage ? `<p class="small muted">Photos and files use ${size(d.storage.used)}${d.storage.free != null ? `. The server has ${size(d.storage.free)} free` : ''}.</p>` : ''}
    <a class="btn" href="/api/export" download="shlen-box-export.txt">Download my export</a>
    ${d.partner ? wipe : ''}
    <button class="btn quiet" data-act="logout">Sign out on this phone</button>`;
}

// ---------- actions ----------
function bind() {
  $app.querySelectorAll('[data-topic]').forEach(b => b.onclick = () => go('topic', Number(b.dataset.topic)));
  $app.querySelectorAll('[data-act]').forEach(b => b.onclick = () => act(b.dataset.act));
  hapticTrigger($app.querySelector('[data-act="send"]'));
  $app.querySelectorAll('[data-help]').forEach(b => b.onclick = () => understand(Number(b.dataset.help)));
  $app.querySelectorAll('[data-del]').forEach(b => b.onclick = () => deleteMessage(Number(b.dataset.del)));
  $app.querySelectorAll('[data-conf]').forEach(b => b.onclick = () => run(async () => {
    const r = await api('POST', `/api/card-points/${b.dataset.conf}/confirm`);
    toast(r.agreed ? 'Both of you confirmed. Marked agreed.' : `Confirmed. Waiting for ${partner().name}.`);
  }));
  $app.querySelectorAll('[data-status]').forEach(b => b.onclick = () => setStatus(b.dataset.status));
  $app.querySelectorAll('[data-pause]').forEach(b => b.onclick = () => run(async () => {
    const note = document.getElementById('pnote').value.trim();
    await api('POST', '/api/pause', { ...JSON.parse(b.dataset.pause), ...(note ? { note } : {}) });
    S.screen = 'home'; toast('Pause started. Both of you can see when talking reopens.');
  }));
  $app.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => {
    S.urgentCat = b.dataset.cat;
    $app.querySelectorAll('[data-cat]').forEach(x => x.setAttribute('aria-pressed', x === b));
  });
  $app.querySelectorAll('[data-view]').forEach(b => b.onclick = () => viewPhoto(b.dataset.view));
  $app.querySelectorAll('[data-unpick]').forEach(b => b.onclick = () => {
    const [p] = pickedFor(S.topicId).splice(Number(b.dataset.unpick), 1);
    if (p?.url) URL.revokeObjectURL(p.url);
    render();
  });
  const picker = document.getElementById('pick');
  if (picker) picker.onchange = () => pick(picker.files);
  const ta = document.getElementById('draft');
  if (ta) ta.oninput = () => setDraft(S.topicId, ta.value);
}

async function run(fn) {
  try { await fn(); } catch (e) { toast(e.message); }
  await load();
}

async function act(a) {
  switch (a) {
    case 'home': return go('home', null);
    case 'topic': return go('topic');
    case 'settings': return go('settings');
    case 'pause': return go('pause');
    case 'urgent': S.urgentCat = null; return go('urgent');
    case 'refresh': return load();
    case 'passkey': return setupPasskey();
    case 'notify': return enableNotifications();
    case 'mute': return run(() => api('POST', '/api/prefs', { mute: !S.data.mute }));
    case 'write': { const t = S.data.topics.find(x => x.name === 'Something bothering me') || S.data.topics[0]; return go('topic', t.id); }
    case 'card': if (!S.topic.card.length) await run(() => api('POST', `/api/topics/${S.topicId}/card`)); return go('card');
    case 'refreshcard': return run(() => api('POST', `/api/topics/${S.topicId}/card`));
    case 'newtopic': return newTopic();
    case 'endpause': return run(async () => { await api('POST', '/api/pause/end'); toast('Talking is open again.'); });
    case 'send': return send();
    case 'pick': return document.getElementById('pick')?.click();
    case 'organize': return organize();
    case 'confstatus': return run(async () => { const r = await api('POST', `/api/topics/${S.topicId}/status/confirm`); toast(`Marked “${STATUS[r.status]}” by both of you.`); });
    case 'deltopic': return confirmSheet('Delete this whole topic?', `All its messages and its summary will be permanently deleted for both of you. ${partner().name} has to agree too.`, 'Delete topic',
      async () => { const r = await api('POST', `/api/delete/${S.topicId}`); if (r.deleted) { toast('Topic deleted.'); S.screen = 'home'; } else toast(`Asked ${partner().name} to agree.`); });
    case 'canceldel': return run(() => api('POST', `/api/delete/${S.topicId}/cancel`));
    case 'sendurgent': return run(async () => {
      if (!S.urgentCat) throw new Error('Choose what it is about first.');
      await api('POST', '/api/urgent', { category: S.urgentCat, text: document.getElementById('utext').value });
      S.urgentCat = null; toast(`Urgent message sent to ${partner().name}.`);
    });
    case 'suggestrule': return run(async () => { await api('POST', '/api/rules', { key: 'morning_time', value: document.getElementById('morning').value }); toast(`Asked ${partner().name} to confirm.`); });
    case 'confrule': return run(async () => { await api('POST', '/api/rules/confirm'); toast('Changed. Both of you agreed.'); });
    case 'cancelrule': return run(() => api('POST', '/api/rules/cancel'));
    case 'wipe': return confirmSheet('Delete everything?', `Every topic, message, summary, pause and urgent message will be permanently deleted for both of you. ${partner().name} has to agree too. Download an export first if you want a copy.`, 'Delete everything',
      async () => { const r = await api('POST', '/api/delete/0'); toast(r.deleted ? 'Everything was deleted.' : `Asked ${partner().name} to agree.`); });
    case 'cancelwipe': return run(() => api('POST', '/api/delete/0/cancel'));
    case 'aikey': return run(async () => { await api('POST', '/api/ai-key', { key: document.getElementById('aikey').value.trim() }); toast('The AI coach is connected.'); });
    case 'aioff': return confirmSheet('Disconnect the AI?', 'Shlen Box goes back to the simple test coach until a key is connected again.', 'Disconnect',
      async () => { await api('DELETE', '/api/ai-key'); toast('Disconnected.'); });
    case 'logout': await api('POST', '/api/logout'); S.data = null; return renderWelcome();
  }
}

function confirmSheet(title, body, label, fn) {
  openSheet(`<b>${esc(title)}</b><p>${esc(body)}</p><button class="btn warn" data-s="yes">${esc(label)}</button><button class="btn quiet" data-s="no">Keep it</button>`,
    { yes: () => { closeSheet(); run(fn); }, no: closeSheet });
}

function newTopic() {
  openSheet(`<b>New topic</b><label for="tname" class="k">Name</label><input type="text" id="tname" maxlength="60">
    <button class="btn pri" data-s="add">Add topic</button><button class="btn quiet" data-s="no">Cancel</button>`,
    { add: async () => { try { const { id } = await api('POST', '/api/topics', { name: document.getElementById('tname').value }); go('topic', id); } catch (e) { toast(e.message); } }, no: closeSheet });
}

function setStatus(to) {
  if (to !== 'try') return run(async () => { const r = await api('POST', `/api/topics/${S.topicId}/status`, { to }); toast(r.pending ? `Asked ${partner().name} to confirm.` : 'Marked still open.'); });
  openSheet(`<b>Try a fix</b><label for="checkin" class="k">When should you check in on how it's going?</label><input type="text" id="checkin" maxlength="40" value="Sunday evening">
    <button class="btn pri" data-s="ok">Ask ${esc(partner().name)} to confirm</button><button class="btn quiet" data-s="no">Cancel</button>`,
    { ok: () => { const checkin = document.getElementById('checkin').value; closeSheet(); run(async () => { await api('POST', `/api/topics/${S.topicId}/status`, { to, checkin }); toast(`Asked ${partner().name} to confirm.`); }); }, no: closeSheet });
}

// One send at a time: a second tap while the first is still going does nothing.
let sending = false;
async function deliver(text, msg, withFiles = true) {
  if (sending) return;
  sending = true;
  $layer.querySelectorAll('.sheet .btn').forEach(b => { b.disabled = true; });
  try {
    // Photos and files go up first, one at a time, then the message that carries them.
    const picked = withFiles ? pickedFor(S.topicId) : [], files = [];
    for (const [i, p] of picked.entries()) {
      if (!p.id) {
        busy($app.querySelector('[data-act="send"]'), picked.length > 1 ? `Sending ${i + 1} of ${picked.length}…` : 'Sending…');
        p.id = (await upload(p.file)).id;
      }
      files.push(p.id);
    }
    await api('POST', `/api/topics/${S.topicId}/messages`, { text, ...(files.length ? { files } : {}) });
    if (picked.length) clearPicked(S.topicId);
    setDraft(S.topicId, ''); closeSheet();
    const box = document.getElementById('draft');
    if (box) box.value = '';
    buzz();
    toast(msg || `Sent. ${partner().name} sees only what you sent.`);
  } catch (e) { closeSheet(); toast(e.message); }
  sending = false;
  await load();
}

async function send() {
  const text = document.getElementById('draft').value.trim();
  const picked = pickedFor(S.topicId).length;
  if (!text && !picked) return toast('Write something first.');
  setDraft(S.topicId, text);
  if (pause()) return toast(`Kept as a private draft. You can send it after ${clock(pause().end)}.`);
  const b = $app.querySelector('[data-act="send"]');
  if (sending || b?.disabled) return;
  buzz();
  busy(b, 'Sending…');
  // The coach reads only words. A photo or file on its own goes straight out.
  try { await (text ? checkAndSend(text) : deliver('', `Sent. ${partner().name} sees only what you sent.`)); } finally { busy(b, null, 'Send'); }
}

async function checkAndSend(text) {
  let r;
  const notChecked = why => openSheet(`<b>${esc(why)}</b><p>You can send your message as it is, or keep it as a draft.</p>
    <button class="btn pri" data-s="send">Send as it is</button><button class="btn" data-s="keep">Keep as draft</button>`,
    { send: () => deliver(text), keep: closeSheet });
  try { r = await withTimeout(api('POST', '/api/check', { text, topic_id: S.topicId }), 15000); }
  catch { return notChecked("The check didn't finish."); }
  if (r.kind === 'unavailable') return notChecked("The check didn't finish.");
  if (r.kind === 'capped') return notChecked(r.message);
  S.pending = { text, r, vi: 0 };
  if (r.kind === 'clear') return deliver(text, 'Looks clear · Sent');
  if (r.kind === 'safety') return safetySheet(true, r.safety_type || '');
  if (r.kind === 'clarify') return clarifySheet();
  flagSheet();
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

const ISSUE_LABEL = {
  unanswered: 'Question not answered yet', new_issue: 'A separate issue', stronger_claim: 'Replying to more than was said',
  sarcastic_agreement: 'Sarcasm', not_said: 'Answering something not said', loop: 'Going in circles', wording: 'Wording',
};

function flagSheet() {
  const { r } = S.pending, v = r.versions[S.pending.vi % r.versions.length];
  const issues = r.issues?.length ? r.issues : [{ phrase: r.phrase, why: r.why }];
  const structural = issues.some(i => i.type && i.type !== 'wording');
  // A version with a [placeholder] needs the author's own answer, so it can't be sent as is.
  const needsAnswer = /\[[^\]]+\]/.test(v);
  openSheet(`<b>${structural ? 'This may pull the conversation off track.' : issues.length > 1 ? `${issues.length} parts may come across more harshly than you intend.` : 'One part may come across more harshly than you intend.'}</b>
    ${r.question_asked ? `<span class="k">${esc(partner().name)} asked</span><div class="box">${esc(r.question_asked)}</div>` : ''}
    ${issues.map(i => `<span class="k">${esc(ISSUE_LABEL[i.type] || 'What may cause a problem')}</span>${i.phrase ? `<div><span class="phrase">${esc(i.phrase)}</span></div>` : ''}<div>${esc(i.why)}</div>`).join('')}
    <span class="k">Suggested version</span><div class="box">${esc(v)}</div>
    ${needsAnswer ? '<p class="small muted">Fill in the part in brackets with your own answer.</p><button class="btn pri" data-s="edit">Write my answer</button>' : '<button class="btn pri" data-s="use">Send this version</button>'}
    <div class="row2">${needsAnswer ? '' : '<button class="btn" data-s="edit">Edit my own words</button>'}<button class="btn" data-s="orig">Send original</button></div>
    ${r.new_topic ? `<button class="btn quiet" data-s="topic">Start a topic: ${esc(r.new_topic)}</button>` : ''}
    <div class="row3"><button class="btn quiet small" data-s="another">Another version</button><button class="btn quiet small" data-s="save">Save</button><button class="btn quiet small" data-s="break">Take a break</button></div>`, {
    use: () => deliver(v, `Sent. ${partner().name} sees only this version.`),
    edit: () => { closeSheet(); document.getElementById('draft')?.focus(); },
    orig: () => deliver(S.pending.text),
    another: () => { S.pending.vi++; flagSheet(); },
    save: () => { closeSheet(); toast('Draft saved on this phone only.'); },
    break: () => go('pause'),
    topic: async () => {
      try { await api('POST', '/api/topics', { name: r.new_topic }); toast(`Started “${r.new_topic}”. You can raise it there.`); } catch (e) { toast(e.message); }
      delete r.new_topic; flagSheet();
    },
  });
}

function clarifySheet() {
  const { r } = S.pending;
  openSheet(`<b>One quick question, just for you</b><p>${esc(r.question)} Your answer makes it clearer for ${esc(partner().name)}.</p>
    ${r.options.map((o, i) => `<button class="btn" data-s="o" data-i="${i}">${esc(o[0].toUpperCase() + o.slice(1))}</button>`).join('')}
    <button class="btn quiet" data-s="else">Something else</button>`, {
    o: async b => {
      let p; try { p = await withTimeout(api('POST', '/api/check', { text: S.pending.text, topic_id: S.topicId, clarify: r.options[Number(b.dataset.i)] }), 15000); } catch { p = {}; }
      if (p.kind !== 'preview') { closeSheet(); return toast(p.message || "That didn't finish. Add a few words about what you mean, then tap Send."); }
      previewSheet('Clearer version', p.text); },
    else: () => { closeSheet(); toast('Add a few words about what you mean, then tap Send.'); },
  });
}

function previewSheet(title, text) {
  openSheet(`<b>${esc(title)}</b><p class="small muted">Only you can see this. It won't go into your text box. Send it as shown, or keep writing in your own words.</p>
    <div class="box">${esc(text)}</div>
    <button class="btn pri" data-s="send">Send this version</button><button class="btn" data-s="own">Keep my own words</button>`,
    { send: () => deliver(text), own: closeSheet });
}

// What the person sees depends on what was written (coaching guide v2, Safety mode).
function safetySheet(author, type = '') {
  const lines = {
    harm: '<b>1-800-799-7233</b> National Domestic Violence Hotline (call, or text START to 88788)<br><b>911</b> for immediate danger',
    self_harm: '<b>988</b> Suicide &amp; Crisis Lifeline (call or text)<br><b>911</b> for immediate danger',
    threatened: '<b>1-800-799-7233</b> National Domestic Violence Hotline (call, or text START to 88788)<br><b>911</b> for immediate danger',
    '': '<b>988</b> Suicide &amp; Crisis Lifeline (call or text)<br><b>1-800-799-7233</b> National Domestic Violence Hotline<br><b>911</b> for immediate danger',
  }[type] ?? '';
  const text = author ? {
    harm: "This message talks about hurting someone. Shlen Box won't suggest a rewrite for this. If anyone may be in danger, please reach out now.",
    self_harm: "It sounds like you may be going through something really hard. You don't have to handle it alone, and you can talk to someone right now.",
    threatened: "It sounds like you may not feel safe. Shlen Box isn't the right tool for this, and you don't need to soften how you say it. Support is available.",
    '': "Part of this message talks about harm. Shlen Box won't suggest a rewrite for this. If anyone may be in danger, please reach out for support.",
  }[type] : {
    harm: "This message talks about hurting someone. Shlen Box won't summarize it. If you or anyone else may be in danger, please reach out now.",
    self_harm: "This message talks about self-harm. Shlen Box won't summarize it. If you're worried about them, you can call 988 for advice on how to help.",
    threatened: "Shlen Box won't summarize this message. If anyone may be in danger, please reach out for support.",
    '': "Shlen Box won't summarize this message. If anyone may be in danger, please reach out for support.",
  }[type];
  openSheet(`<b>${author ? 'Before you send this' : 'This message mentions safety'}</b>
    <p>${text ?? ''}</p>
    <div class="box">${lines}</div>
    ${author ? '<button class="btn" data-s="save">Keep as draft</button><button class="btn quiet" data-s="send">Send as written</button>' : '<button class="btn" data-s="close">Close</button>'}`,
    { save: closeSheet, close: closeSheet, send: () => deliver(S.pending.text) });
}

async function understand(id) {
  let h;
  try { h = await api('POST', `/api/messages/${id}/understand`); } catch (e) { return toast(e.message); }
  if (h.kind === 'safety') return safetySheet(false, h.safety_type || '');
  const heard = `Here's what I heard: ${h.heard || h.main.replace(/^.*? wrote: /, '')} Is that right?`;
  openSheet(`<b>Help me understand</b><p class="small muted">Only you can see this. It restates what was written. It doesn't guess why.</p>
    ${h.question ? `<span class="k">Their question, to answer first</span><div class="box">${esc(h.question)}</div>` : ''}
    <span class="k">What they said</span><div>${esc(h.main)}</div>
    <span class="k">Request</span><div>${esc(h.request)}</div>
    <span class="k">A question you could ask</span><div class="box">${esc(h.ask)}</div>
    <span class="k">Reply by checking what you heard</span><div class="box">${esc(heard)}</div>
    ${pause() ? '' : '<button class="btn pri" data-s="heard">Send this reply</button>'}
    <button class="btn quiet" data-s="close">Close</button>`, { heard: () => deliver(heard, undefined, false), close: closeSheet });
}

function viewPhoto(id) {
  const f = { id };
  openSheet(`<img class="viewer" src="${fileUrl(f)}" alt="Photo"><a class="btn" href="${fileUrl(f, true)}" download>Save photo</a>
    <button class="btn quiet" data-s="close">Close</button>`, { close: closeSheet });
}

function deleteMessage(id) {
  confirmSheet('Delete this message for both of you?', `${partner().name} will see “Message deleted.” This can't be undone.`, 'Delete permanently',
    async () => { await api('DELETE', `/api/messages/${id}`); toast('Deleted.'); });
}

const ORGANIZE_QUESTIONS = ['What happened?', 'How did it affect you?', 'What do you need them to understand?', 'What would you like to happen next?'];

function organize() {
  openSheet(`<b>Help me organize this</b><p class="small muted">All optional. Your answers are put together into one message you can send or skip.</p>
    ${ORGANIZE_QUESTIONS.map((q, i) => `<label class="k" for="o${i}">${q}</label><input type="text" id="o${i}" maxlength="300">`).join('')}
    <button class="btn pri" data-s="make">Put it together</button><button class="btn quiet" data-s="close">Cancel</button>`, {
    close: closeSheet,
    make: async b => {
      if (b.disabled) return;
      const answers = ORGANIZE_QUESTIONS.map((_, i) => document.getElementById('o' + i).value.trim());
      if (!answers.some(Boolean)) return closeSheet();
      buzz();
      busy(b, 'Putting it together…');
      let r;
      try { r = await withTimeout(api('POST', '/api/organize', { answers, topic_id: S.topicId }), 20000); }
      catch (e) { busy(b, null, 'Put it together'); return toast(e.message === 'timeout' ? "That didn't finish. Please try again." : e.message); }
      if (r.kind === 'safety') { S.pending = { text: answers.filter(Boolean).join(' ') }; return safetySheet(true, r.safety_type || ''); }
      previewSheet('Your answers, put together', r.text);
    },
  });
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
load();
