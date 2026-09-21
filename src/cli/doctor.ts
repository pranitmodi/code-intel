import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { Ollama } from 'ollama';
import type { CodeIntelConfig } from '../config/types.js';
import { resolveRepoPaths } from '../config/paths.js';
import { computeRepoId } from '../utils/repo-id.js';
import { createEmbeddingProvider } from '../embeddings/createEmbeddingProvider.js';
import { formatCliFailure } from './formatCliFailure.js';

export function ollamaHasModel(models: Array<{ name: string }>, model: string): boolean {
  return models.some((entry) => entry.name === model || entry.name.startsWith(`${model}:`));
}

export async function ensureOllamaModel(host: string, model: string): Promise<void> {
  const client = new Ollama({ host });
  const { models } = await client.list();
  if (ollamaHasModel(models, model)) return;

  console.log(`Pulling Ollama model "${model}" (this can take a few minutes)…`);
  const stream = await client.pull({ model, stream: true });
  for await (const part of stream) {
    const pct =
      part.total > 0 ? ` ${Math.min(100, Math.round((part.completed / part.total) * 100))}%` : '';
    process.stdout.write(`\r[PULL] ${part.status}${pct}`.padEnd(80));
  }
  process.stdout.write('\n');
}

export async function runDoctor(options: {
  repoRoot: string;
  config: CodeIntelConfig;
  fix?: boolean;
}): Promise<boolean> {
  const { repoRoot, config, fix } = options;
  let healthy = true;

  if (config.embedding.provider === 'ollama') {
    const client = new Ollama({ host: config.embedding.host });
    try {
      if (fix) {
        await ensureOllamaModel(config.embedding.host, config.embedding.model);
      }
      const { models } = await client.list();
      console.log(`[OK] Ollama reachable at ${config.embedding.host}`);
      if (ollamaHasModel(models, config.embedding.model)) {
        console.log(`[OK] Model "${config.embedding.model}" is available`);
      } else {
        healthy = false;
        console.log(
          formatCliFailure(
            new Error(
              fix
                ? `Ollama model "${config.embedding.model}" is not available locally (pull failed).`
                : `Ollama model "${config.embedding.model}" is not available locally.`
            )
          )
        );
      }
    } catch (error) {
      healthy = false;
      console.log(formatCliFailure(error));
    }
  } else {
    try {
      const provider = createEmbeddingProvider(config.embedding);
      const dimensions = await provider.dimensions();
      console.log(`[OK] Embedding proxy reachable at ${config.embedding.baseUrl}`);
      console.log(`[OK] Model "${config.embedding.model}" returned ${dimensions}-dimension vectors`);
    } catch (error) {
      healthy = false;
      console.log(formatCliFailure(error));
    }
  }

  const repoId = computeRepoId(repoRoot);
  const paths = resolveRepoPaths(config, repoRoot, repoId);
  try {
    mkdirSync(paths.dbDir, { recursive: true });
    const probeFile = `${paths.dbDir}/.write-probe`;
    writeFileSync(probeFile, 'ok');
    rmSync(probeFile);
    console.log(`[OK] Index directory is writable (${paths.indexDir})`);
  } catch (error) {
    healthy = false;
    const detail = error instanceof Error ? error.message : String(error);
    console.log(formatCliFailure(new Error(`Index directory is not writable (${paths.indexDir}): ${detail}`)));
  }

  console.log(
    existsSync(paths.lockFile)
      ? '[INFO] A lock file is present — another process may be indexing.'
      : '[OK] No stale lock file.'
  );

  return healthy;
}
