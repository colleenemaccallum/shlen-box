// Chooses the coach: the real AI when an AI key is set, otherwise the simple stand-in.
// The key can come from the ANTHROPIC_API_KEY environment variable or be pasted once in Settings
// (stored in the secrets table, never sent back to any phone).
import Anthropic from '@anthropic-ai/sdk';
import * as standIn from './coach.js';
import { createAiCoach, MODEL } from './ai-coach.js';

// Checks a key with a token count, which the provider doesn't charge for.
export async function verifyKey(apiKey) {
  try {
    await new Anthropic({ apiKey, timeout: 10000, maxRetries: 0 }).messages.countTokens({ model: MODEL, messages: [{ role: 'user', content: 'Hi' }] });
    return true;
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return false;
    throw new Error('unreachable');
  }
}

export function createCoachSwitch({ db, now = () => new Date(), capUsd = 10, envKey = null, makeAi = createAiCoach, verify = verifyKey }) {
  const q = sql => db.prepare(sql);
  const storedKey = () => q("SELECT value FROM secrets WHERE key = 'anthropic_api_key'").get()?.value || null;
  let ai = null, aiKey = null;
  function active() {
    const key = envKey || storedKey();
    if (!key) return standIn;
    if (key !== aiKey) { ai = makeAi({ db, now, apiKey: key, capUsd }); aiKey = key; }
    return ai;
  }
  const spent = () => q('SELECT COALESCE(SUM(usd), 0) AS usd FROM ai_usage WHERE month = ?').get(now().toISOString().slice(0, 7)).usd;

  return {
    get STAND_IN() { return active() === standIn; },
    check: (...a) => active().check(...a),
    clarify: (...a) => active().clarify(...a),
    understand: (...a) => active().understand(...a),
    draftCard: (...a) => active().draftCard(...a),
    status: () => ({ connected: !!(envKey || storedKey()), from_settings: !envKey && !!storedKey(),
      spent: Math.round(spent() * 100) / 100, cap: capUsd }),
    // Returns 'ok', 'wrong' (the provider refused the key) or 'unreachable'.
    async setKey(key) {
      let ok; try { ok = await verify(key); } catch { return 'unreachable'; }
      if (!ok) return 'wrong';
      q("INSERT INTO secrets (key, value) VALUES ('anthropic_api_key', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key);
      return 'ok';
    },
    clearKey: () => q("DELETE FROM secrets WHERE key = 'anthropic_api_key'").run(),
  };
}
