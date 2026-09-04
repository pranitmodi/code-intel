/**
 * Heuristic binary-file detector: looks for a NUL byte in the first chunk of
 * the file. Cheap and standard (same idea `git` and `file` use), catches
 * binary files that don't match a known extension pattern.
 */
export function looksBinary(buffer: Buffer): boolean {
  const sampleSize = Math.min(buffer.length, 8000);
  for (let i = 0; i < sampleSize; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}
