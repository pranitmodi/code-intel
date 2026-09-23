const DOC_EXT = /\.(?:md|mdc|mdx|markdown|rst|adoc|txt)$/i;
const DOC_NAME = /(?:^|\/)(?:readme|changelog|contributing|license|notice|authors)(?:\.[^/]+)?$/i;
const DOC_QUERY = /\b(?:docs?|documentation|readme|changelog|guide|tutorial|markdown|faq|wiki)\b|\.(?:md|mdc|mdx|rst)\b/i;
const EXPLANATION_QUERY = /\b(?:how|why|explain|overview|architecture|design|concepts?|works?)\b/i;

export function isDocPath(filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/');
  return DOC_EXT.test(normalized) || DOC_NAME.test(normalized);
}

/**
 * Weight for prose chunks. Docs cost as many tokens as code and can be stale:
 * full weight when the task is about documentation, slightly reduced when it
 * asks how something works, and reduced further for "where/fix/add" tasks
 * whose answer is the code itself.
 */
export function proseWeightFor(query: string): number {
  if (DOC_QUERY.test(query)) return 1;
  if (EXPLANATION_QUERY.test(query)) return 0.85;
  return 0.7;
}
