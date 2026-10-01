// Stand-in coach. It has the same interface the real AI helper will have (ARCHITECTURE section 5),
// so the rest of the app doesn't change when it is swapped. It is rule-based and never stores text.
//
//   check(draft)             -> { kind: 'clear' } | { kind: 'flag', phrase, why, versions[] }
//                               | { kind: 'clarify', question, options[] } | { kind: 'safety' }
//   organize(answers)       -> { kind: 'preview', text } | { kind: 'safety' }
//   understand(text)         -> { kind: 'help', main, request, ask } | { kind: 'safety' }
//   draftCard(topic, msgs)   -> [{ section, text, label, account_of }]

export const STAND_IN = true;

const THREAT = /\b(kill|hurt you|hit you|kill myself|end it all|you'?ll regret|i'?ll make you)\b/i;

const PATTERNS = [
  { re: /\byou (never|always) [^.!?,]*?(?= and |[.!?,]|$)/i,
    why: m => `"${m.match(/never|always/i)[0]}" is absolute. The other person may answer by listing exceptions instead of talking about the actual problem.` },
  { re: /\byou don'?t (give a (shit|damn|fuck)|care)[^.!?]*/i,
    why: () => 'This states a motive. The conversation can turn into an argument about whether they care, instead of what happened.' },
  { re: /\b(stupid|idiot|pathetic|ridiculous|selfish)\b[^.!?]*/i,
    why: () => 'This labels the person rather than describing what they did. People usually defend themselves against a label instead of answering the point.' },
  { re: /[^.!?]*\b(fuck\w*|shit\w*)\b[^.!?]*/i,
    why: () => 'Strong swearing can read as hostility and pull attention away from what you are asking for.' },
  { re: /\bwhatever\b[^.!?]*/i,
    why: () => '"Whatever" can read as dismissing what they said, which tends to escalate rather than end the disagreement.' },
];

function soften(text) {
  const s = text
    .replace(/\byou never\b/gi, "it often feels like you don't")
    .replace(/\byou always\b/gi, 'it often feels like you')
    .replace(/\byou don'?t (give a (shit|damn|fuck)|care)( about)?/gi, "I'm not sure you see how much this matters to me")
    .replace(/\b(fucking|fuckin|fuck|shit|damn)\s*/gi, '')
    .replace(/\b(stupid|idiot|pathetic|ridiculous|selfish)\b/gi, 'frustrating')
    .replace(/\bi'?m sick of\b/gi, "I'm worn out by")
    .replace(/\s{2,}/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function check(draft) {
  if (THREAT.test(draft)) return { kind: 'safety' };
  if (/can'?t keep doing this/i.test(draft)) {
    return { kind: 'clarify', question: 'What does "this" refer to?',
      options: ['this argument', 'the current household arrangement', "the way we're talking to each other"] };
  }
  for (const p of PATTERNS) {
    const m = draft.match(p.re);
    if (m) {
      const base = soften(draft);
      return { kind: 'flag', phrase: m[0].trim(), why: p.why(m[0]), versions: [
        `I'm frustrated, and I want us to work this out. ${base}`,
        `${base} Can we focus on what needs to change this time?`,
        `This matters to me. ${base} What would you suggest?`,
      ] };
    }
  }
  return { kind: 'clear' };
}

export function clarify(draft, answer) {
  return draft.replace(/can'?t keep doing this/i, `can't keep doing ${answer}`);
}

// Each answer becomes its own sentence, in the order asked. No stock lead-ins: they turned answers that
// were already sentences into a jumble ("Could we I would like ...").
export function organize(answers) {
  if (answers.some(a => THREAT.test(a))) return { kind: 'safety' };
  const sentence = a => {
    const t = a.trim().replace(/\s+/g, ' ');
    return t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.');
  };
  return { kind: 'preview', text: answers.filter(a => a && a.trim()).map(sentence).join(' ') };
}

export function understand(text, authorName) {
  if (THREAT.test(text)) return { kind: 'safety' };
  const first = text.split(/(?<=[.!?])\s+/)[0];
  const question = text.split(/(?<=[.!?])\s+/).find(s => s.endsWith('?'));
  return {
    kind: 'help',
    main: `${authorName} wrote: "${first}"`,
    request: question ? `They asked: "${question}" It may help to answer that first.` : 'No direct request.',
    ask: 'What would help most right now?',
  };
}

export function draftCard(topic, messages, people) {
  const points = [{ section: 'The issue', text: `What's happening with ${topic.name.toLowerCase()}.`, label: 'draft', account_of: null }];
  for (const p of people) {
    const last = [...messages].reverse().find(m => m.author === p.id && !m.deleted);
    if (last) points.push({ section: 'Still different', text: last.text, label: 'account', account_of: p.id });
  }
  points.push({ section: 'Open question', text: 'What would a good outcome look like for each of you?', label: 'draft', account_of: null });
  return points;
}
