/** L2-normalizes a vector so stored/query embeddings share a unit-length space (cosine ~ L2 rank order). */
export function normalizeVector(vector: number[]): number[] {
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;
  const norm = Math.sqrt(sumSquares);
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}
