// Scores one coach answer against its test case's expectations. Returns the reasons it fails (empty = pass).
const ADDED_APOLOGY = /\b(sorry|apologi[sz]e|my fault|forgive me)\b/i;
const THERAPY_WORDS = /\b(DEAR MAN|validat\w*|stonewall\w*|narcissis\w*|gaslight\w*|abus\w*|toxic|trauma\w*|codependen\w*|attachment style)\b/i;
const low = s => (s || '').toLowerCase();
const listOf = v => v === undefined ? null : [].concat(v);

export function grade(c, r) {
  const e = c.expect || {}, bad = [];
  const kinds = listOf(e.kind);
  if (kinds && !kinds.includes(r.kind)) bad.push(`kind ${r.kind}, expected ${kinds.join(' or ')}`);
  if (e.kind_not && r.kind === e.kind_not) bad.push(`kind should not be ${e.kind_not}`);
  if (e.safety_type && r.safety_type !== e.safety_type) bad.push(`safety type ${r.safety_type || 'none'}, expected ${e.safety_type}`);
  if (r.kind !== 'flag') return bad;
  const types = (r.issues || []).map(i => i.type), phrases = (r.issues || []).map(i => low(i.phrase));
  if (e.types && !e.types.some(t => types.includes(t))) bad.push(`issue types ${types.join(', ') || 'none'}, expected one of ${e.types.join(', ')}`);
  for (const t of e.forbid_types || []) if (types.includes(t)) bad.push(`should not flag ${t}`);
  for (const p of e.flagged || []) if (!phrases.some(f => f.includes(low(p)))) bad.push(`did not flag "${p}"`);
  for (const p of e.not_flagged || []) if (phrases.some(f => f && (f.includes(low(p)) || low(p).includes(f)))) bad.push(`flagged "${p}", which should stay`);
  if (e.question && !r.question_asked) bad.push('did not name the unanswered question');
  for (const w of e.keep_some || []) if (!r.versions.some(v => low(v).includes(low(w)))) bad.push(`no version keeps "${w}"`);
  for (const v of r.versions) {
    if (ADDED_APOLOGY.test(v) && !ADDED_APOLOGY.test(c.draft)) bad.push(`a version adds an apology: "${v}"`);
    if (/Person [AB]/.test(v)) bad.push('a version still says Person A/B');
  }
  for (const t of [...r.versions, ...(r.issues || []).map(i => i.why)]) if (THERAPY_WORDS.test(t)) bad.push(`therapy wording: "${t}"`);
  return bad;
}

