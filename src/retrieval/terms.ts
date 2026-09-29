/**
 * Words used to compare a task with code. Identifiers are split on case and
 * separators (`systemCaChildEnv` -> system, ca, child, env), everything is
 * lowercased, and a trailing plural "s" is dropped so "servers" meets "server".
 */

/** Prose words that say nothing about which code is meant. */
export const PROSE_STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'for', 'with', 'without', 'from', 'into', 'onto', 'of', 'to', 'in',
  'on', 'at', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these',
  'those', 'there', 'their', 'them', 'they', 'we', 'you', 'your', 'our', 'my', 'me', 'i', 'he', 'she', 'his', 'her',
  'how', 'what', 'when', 'where', 'which', 'who', 'why', 'whether', 'does', 'do', 'did', 'done', 'doing', 'can',
  'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must', 'has', 'have', 'had', 'not', 'no', 'yes',
  'if', 'then', 'else', 'than', 'so', 'such', 'also', 'too', 'very', 'just', 'only', 'any', 'all', 'each', 'every',
  'some', 'other', 'another', 'more', 'most', 'less', 'least', 'about', 'after', 'before', 'between', 'through',
  'during', 'over', 'under', 'again', 'here', 'versus', 'vs', 'via', 'per', 'like', 'please', 'explain', 'describe',
  'show', 'tell', 'find', 'happen', 'happens', 'work', 'works', 'working', 'make', 'makes', 'use', 'uses', 'used',
  'using', 'get', 'gets', 'set', 'sets', 'add', 'fix', 'update', 'change', 'handle', 'handles', 'handled', 'handling',
  'cope', 'copes', 'thing', 'things', 'way', 'ways', 'new', 'old', 'same', 'different', 'implemented',
  'implementation', 'implement', 'code', 'file', 'files', 'function', 'functions', 'part', 'parts'
]);

export function singular(word: string): string {
  // Short plurals: "ids" -> "id", "cas" -> "ca"; "bus" and "gas" stay.
  if (word.length === 3 && word.endsWith('s') && !/(?:ss|us|is|os|as)$/.test(word)) return word.slice(0, -1);
  if (word.length <= 3) return word;
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('sses') || word.endsWith('xes') || word.endsWith('ches') || word.endsWith('shes')) return word.slice(0, -2);
  if (/(?:ss|us|is|os)$/.test(word)) return word;
  return word.endsWith('s') ? word.slice(0, -1) : word;
}

/**
 * Light suffix stripping so verb forms meet: computed/computing/compute ->
 * comput, reused/reuse -> reus, indexing/indexed -> index. Applied to both
 * task words and code words, so it only has to be consistent, not correct.
 */
export function stem(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('e')) return word.slice(0, -1);
  return word;
}

function normalizeWord(word: string): string {
  return stem(singular(word));
}

/** Split identifiers and prose into lowercase singular, lightly stemmed words. */
export function wordsOf(text: string): string[] {
  const words: string[] = [];
  for (const raw of text.match(/[A-Za-z][A-Za-z0-9]*/g) ?? []) {
    // Plural acronyms: "IDs", "URLs", "APIs", "CAs".
    if (/^[A-Z]{2,}s$/.test(raw)) {
      words.push(raw.slice(0, -1).toLowerCase());
      continue;
    }
    const parts = raw
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .toLowerCase()
      .split(' ');
    for (const part of parts) if (part) words.push(normalizeWord(part));
    // Also keep a camelCase or PascalCase identifier whole, compacted ("systemca").
    if (parts.length > 1) words.push(raw.toLowerCase());
  }
  return words;
}

/** Distinct content words of a task segment: no prose stop words, at least two letters. */
export function contentWords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const raw = new Set((text.match(/[A-Za-z]+/g) ?? []).map((word) => word.toLowerCase()));
  const stopped = new Set([...raw].filter((word) => PROSE_STOP_WORDS.has(word)).map(normalizeWord));
  for (const word of wordsOf(text)) {
    if (word.length < 2 || PROSE_STOP_WORDS.has(word) || stopped.has(word) || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

/** Every word a chunk offers for matching: its path, symbol names, and text. */
export function chunkWordSet(input: { file: string; symbol?: string | null; content: string }): Set<string> {
  return new Set([
    ...wordsOf(input.file.replace(/\.[^./]+$/, '')),
    ...(input.symbol ? wordsOf(input.symbol) : []),
    ...wordsOf(input.content)
  ]);
}
