/**
 * Bumped whenever chunk boundaries or stored metadata change. Files indexed by
 * an older chunker are re-chunked on the next index run even when their
 * content is unchanged; embeddings are reused wherever chunk text still matches.
 *
 * 3: every top-level statement is chunked (commands, constants, tests),
 *    doc comments and `export` stay with their declaration, class headers are
 *    separate from methods, and chunks carry signature/calls/literals.
 */
export const CHUNKER_VERSION = 3;
