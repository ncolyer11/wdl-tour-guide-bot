import { helpRequestRules as rules, farmQuestionPhrases, farmQuestionExclusions } from './strings';

const CONTRACTIONS: Record<string, string> = { wheres: 'where is' };

/** Lower-case, strip apostrophes ("cant", "wheres"), turn other punctuation into spaces, split into words. */
export function tokenise(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .flatMap(token => CONTRACTIONS[token]?.split(' ') ?? [token]);
}

const strong = new Set(rules.strongTargets);
const weak = new Set(rules.weakTargets);
const skippable = new Set(rules.skippable);
const askCues = rules.askCues.map(tokenise);
const haveCues = rules.haveCues.map(tokenise);
const exactPhrases = rules.exactPhrases.map(tokenise);

const phraseAt = (tokens: string[], at: number, phrase: string[]): boolean =>
  phrase.every((word, offset) => tokens[at + offset] === word);

/** After a cue ends at `from`, is there a target within a few filler words? */
function targetFollows(tokens: string[], from: number, weakAllowedAlone: boolean): boolean {
  for (let i = from; i < tokens.length && i - from <= rules.maxSkip; i++) {
    const token = tokens[i];
    if (strong.has(token)) return true;
    if (weak.has(token) && (weakAllowedAlone || tokens[i + 1] === 'that')) return true;
    if (!skippable.has(token)) return false;
  }
  return false;
}

function cueMatches(tokens: string[], cues: string[][], weakAllowedAlone: boolean): boolean {
  for (let i = 0; i < tokens.length; i++) {
    for (const cue of cues) {
      if (phraseAt(tokens, i, cue) && targetFollows(tokens, i + cue.length, weakAllowedAlone)) return true;
    }
  }
  return false;
}

/** "Where is the download", "cant find the schem", "is there a farm that...", etc. */
export function matchesHelpRequest(content: string): boolean {
  const tokens = tokenise(content);
  if (exactPhrases.some(phrase => tokens.some((_, i) => phraseAt(tokens, i, phrase)))) return true;
  return cueMatches(tokens, askCues, true) || cueMatches(tokens, haveCues, false);
}

// Plain words/numbers get word boundaries; anything else (like a double quote) is a substring test.
const exclusionTests = farmQuestionExclusions.map(phrase =>
  /^[\w,]+$/.test(phrase) ? new RegExp(`\\b${phrase}\\b`, 'i') : { test: (text: string) => text.includes(phrase) }
);

/** "the wood farm doesn't work": a vague farm question that needs the farm's name. */
export function matchesFarmQuestion(content: string): boolean {
  const lower = content.toLowerCase();
  return farmQuestionPhrases.some(phrase => lower.includes(phrase)) && !exclusionTests.some(test => test.test(content));
}

/** "paper" as a whole word, so "wallpaper" and "newspaper" don't trigger it. */
export const mentionsPaper = (content: string): boolean => /\bpaper\b/i.test(content);
