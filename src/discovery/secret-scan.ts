/**
 * Lightweight, pattern-based detection of likely secret VALUES inside file
 * content — defense in depth beyond filename-based exclusion, for files that
 * are otherwise allowed (e.g. a config file that happens to embed a live key).
 * This is a heuristic, not a guarantee; it deliberately favors precision
 * (fewer false positives) over exhaustive coverage.
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /-----BEGIN (RSA|EC|DSA|OPENSSH|PGP) PRIVATE KEY-----/,
  /-----BEGIN PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/, // AWS access key id
  /aws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}/i,
  /(sk|pk)_(live|test)_[0-9a-zA-Z]{16,}/, // Stripe-style keys
  /ghp_[0-9A-Za-z]{36}/, // GitHub personal access token
  /github_pat_[0-9A-Za-z_]{22,}/,
  /xox[baprs]-[0-9A-Za-z-]{10,}/, // Slack tokens
  /-----BEGIN CERTIFICATE-----/
];

export function containsLikelySecret(content: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(content));
}
