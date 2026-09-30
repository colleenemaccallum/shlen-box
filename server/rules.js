// Pure rules with no I/O, so they are easy to test.

const HOUR = 3600e3;
export const MIN_HOURS_BEFORE_MORNING = 4;
export const URGENT_CATEGORIES = ['Safety', 'Health', 'Kids & pickups', 'Home emergency', 'Time-sensitive plans'];
export const URGENT_MAX = 280;
export const MESSAGE_MAX = 5000;

function atTime(base, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d;
}

// Latest a pause may end: the first morning time at least 4 hours after it starts (PRD F21).
export function maxPauseEnd(start, morningTime) {
  const earliest = new Date(start.getTime() + MIN_HOURS_BEFORE_MORNING * HOUR);
  const m = atTime(start, morningTime);
  while (m < earliest) m.setDate(m.getDate() + 1);
  return m;
}

// Next occurrence of a clock time strictly after `start`.
export function nextAt(start, hhmm) {
  const t = atTime(start, hhmm);
  if (t <= start) t.setDate(t.getDate() + 1);
  return t;
}

// spec: { minutes } | { until: 'tonight' | 'morning' } | { at: ISO string }
export function resolvePauseEnd(spec, start, rules) {
  let end;
  if (Number.isFinite(spec.minutes)) end = new Date(start.getTime() + spec.minutes * 60e3);
  else if (spec.until === 'tonight') end = nextAt(start, rules.tonight_time);
  else if (spec.until === 'morning') end = maxPauseEnd(start, rules.morning_time);
  else if (typeof spec.at === 'string') end = new Date(spec.at);
  else return { error: 'Choose how long the pause lasts.' };
  if (Number.isNaN(end.getTime())) return { error: 'That time could not be read.' };
  if (end <= start) return { error: 'The pause has to end in the future.' };
  const max = maxPauseEnd(start, rules.morning_time);
  if (end > max) return { error: `A pause can last until ${fmtClock(max)} at the latest.`, max };
  return { end };
}

export function isValidClock(v) {
  return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

function fmtClock(d) {
  return d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}
