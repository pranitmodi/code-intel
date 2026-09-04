import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LanceVectorStore } from '../vector-store/LanceVectorStore.js';

export interface RepoContext {
  totalFiles: number;
  languages: { language: string; percent: number }[];
  topDirectories: { directory: string; fileCount: number }[];
  packageManagerFiles: string[];
}

const PACKAGE_MANAGER_FILES = [
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'Gemfile',
  'composer.json',
  'docker-compose.yml',
  'Dockerfile'
];

/** Deterministic metadata rollup (spec section 19) — no LLM summarization by default. */
export async function getRepoContext(repoRoot: string, vectorStore: LanceVectorStore): Promise<RepoContext> {
  const rows = await vectorStore.queryAll(['language', 'file_path']);

  const fileLanguage = new Map<string, string>();
  for (const row of rows) fileLanguage.set(row.file_path, row.language);

  const languageCounts = new Map<string, number>();
  for (const language of fileLanguage.values()) {
    languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
  }

  const totalFiles = fileLanguage.size;
  const languages = [...languageCounts.entries()]
    .map(([language, count]) => ({
      language,
      percent: totalFiles > 0 ? Math.round((count / totalFiles) * 1000) / 10 : 0
    }))
    .sort((a, b) => b.percent - a.percent);

  const directoryCounts = new Map<string, number>();
  for (const filePath of fileLanguage.keys()) {
    const directory = filePath.includes('/') ? (filePath.split('/')[0] ?? '.') : '.';
    directoryCounts.set(directory, (directoryCounts.get(directory) ?? 0) + 1);
  }
  const topDirectories = [...directoryCounts.entries()]
    .map(([directory, fileCount]) => ({ directory, fileCount }))
    .sort((a, b) => b.fileCount - a.fileCount)
    .slice(0, 10);

  const packageManagerFiles = PACKAGE_MANAGER_FILES.filter((name) => existsSync(join(repoRoot, name)));

  return { totalFiles, languages, topDirectories, packageManagerFiles };
}
