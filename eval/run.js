// Runs the coach test cases against the real AI and scores each answer (coaching guide v2, test plan).
// Spends real money from the AI budget, so it stops before going over --max-usd (default $3).
//
//   node eval/run.js [--sets a,b,safety] [--only A01,B06] [--file private-cases.json] [--max-usd 3]
//                    [--db /var/lib/shlen-box/shlen-box.db] [--out results.json]
//
// The AI key comes from SHLEN_AI_KEY (or ANTHROPIC_API_KEY), or with --db from the key saved in the app's Settings.
// With --db the spending is also added to that month's total, so the app's monthly cap still holds.
// Names in the cases (Alex, Jordan) go through the same name hiding as the app.
import { readFileSync, writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { openDb } from '../server/db.js';
import { createAiCoach } from '../server/ai-coach.js';
import { grade } from './grade.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a, []));
const maxUsd = Number(args['max-usd'] || 3);
const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url))).sets;
if (args.file) cases.c = JSON.parse(readFileSync(args.file, 'utf8')).cases;
const sets = [...new Set([...(args.sets || Object.keys(cases).join(',')).split(','), ...(args.file ? ['c'] : [])])];
const only = args.only ? new Set(args.only.split(',')) : null;
const todo = sets.flatMap(s => (cases[s] || []).map(c => ({ ...c, set: s }))).filter(c => !only || only.has(c.id));

const live = args.db ? openDb(args.db) : null;
const apiKey = process.env.SHLEN_AI_KEY || process.env.ANTHROPIC_API_KEY || live?.prepare("SELECT value FROM secrets WHERE key = 'anthropic_api_key'").get()?.value;
// --injected: the key is added on the way out by the environment's credential store, so it never
// passes through this program; the SDK is told to send no key header of its own.
const injected = 'injected' in args;
if (!apiKey && !injected) { console.error('No AI key: set SHLEN_AI_KEY, pass --db with a key saved in Settings, or use --injected.'); process.exit(1); }
const month = new Date().toISOString().slice(0, 7), liveCap = Number(process.env.AI_CAP_USD || 10);
const liveSpent = () => live.prepare('SELECT COALESCE(SUM(usd), 0) AS usd FROM ai_usage WHERE month = ?').get(month).usd;
if (live && liveSpent() + maxUsd > liveCap) {
  console.error(`Not started: this month's AI spending is $${liveSpent().toFixed(2)} of $${liveCap}, and a run can use up to $${maxUsd}.`);
  process.exit(1);
}

// The run's own counter: the coach refuses any request that could pass maxUsd.
const scratch = openDb(':memory:');
const client = injected ? new Anthropic({ apiKey: null, authToken: null, defaultHeaders: { 'X-Api-Key': null }, timeout: 90000, maxRetries: 0 }) : null;
const coach = createAiCoach({ db: scratch, apiKey, client, capUsd: maxUsd, timeoutMs: 90000 });
const people = [{ id: 1, name: 'Alex' }, { id: 2, name: 'Jordan' }];

async function runOne(c) {
  const messages = (c.conversation || []).map(([who, text], i) => ({ id: i + 1, author: who === 'A' ? 1 : 2, text, deleted: 0 }));
  const ctx = { people, authorId: 1, messages, card: [], topic: { name: c.topic || 'Home' } };
  try {
    const r = await coach.check(c.draft, ctx);
    return { ...c, result: r, failures: grade(c, r) };
  } catch (err) {
    return { ...c, result: null, failures: [err.capped ? 'stopped: run budget reached' : 'the AI did not answer'] };
  }
}

const results = [];
for (let i = 0; i < todo.length; i += 4) results.push(...await Promise.all(todo.slice(i, i + 4).map(runOne)));
const usd = coach.spent();
if (live) live.prepare("INSERT INTO ai_usage (month, kind, usd, created) VALUES (?, 'test', ?, ?)").run(month, usd, new Date().toISOString());

const failed = results.filter(r => r.failures.length);
for (const s of sets) {
  const inSet = results.filter(r => r.set === s);
  if (inSet.length) console.log(`Set ${s.toUpperCase()}: ${inSet.length - inSet.filter(r => r.failures.length).length} of ${inSet.length} passed`);
}
console.log(`Cost of this run: $${usd.toFixed(2)}\n`);
for (const f of failed) {
  const r = f.result;
  console.log(`${f.id}  "${f.draft}"`);
  for (const why of f.failures) console.log(`   - ${why}`);
  if (r?.kind === 'flag') console.log(`   coach: ${r.issues.map(i => `[${i.type}] ${i.phrase || '(whole message)'}`).join('; ')}\n   version 1: ${r.versions[0]}`);
}
if (args.out) writeFileSync(args.out, JSON.stringify({ when: new Date().toISOString(), usd, results }, null, 1));
