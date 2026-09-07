/** Same 4-chars-per-token estimate used to cap `search_codebase` payloads. */
export const CHARS_PER_TOKEN = 4;

export function estimateTokensFromChars(chars: number): number {
  if (chars <= 0) return 0;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function estimateTokensFromText(text: string): number {
  return estimateTokensFromChars(text.length);
}
