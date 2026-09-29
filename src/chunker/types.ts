export interface CodeChunk {
  symbolName: string | null;
  symbolType: string | null;
  parentSymbol: string | null;
  startLine: number;
  endLine: number;
  content: string;
  /** Facts read from the syntax tree, merged into the chunk's stored metadata. */
  meta?: {
    /** Declaration up to its body: `export async function f(a: number): Promise<void>`. */
    signature?: string;
    /** Names of functions and methods called. */
    calls?: string[];
    /** Code-shaped string literals: command names, flags, env keys, routes. */
    literals?: string[];
    /** Members of a class header chunk with their line ranges: `run:L12-40`. */
    defines?: string[];
  };
}
