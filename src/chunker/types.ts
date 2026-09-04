export interface CodeChunk {
  symbolName: string | null;
  symbolType: string | null;
  parentSymbol: string | null;
  startLine: number;
  endLine: number;
  content: string;
}
