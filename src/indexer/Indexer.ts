import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import type { CodeIntelConfig } from '../config/types.js';
import type { RepoPaths } from '../config/paths.js';
import { discoverFiles, type DiscoveredFile } from '../discovery/discover.js';
import { looksBinary } from '../discovery/binary-check.js';
import { containsLikelySecret } from '../discovery/secret-scan.js';
import { chunkFile } from '../chunker/chunker.js';
import { computeChunkId, hashChunkContent, hashFileContent } from '../hashing/hash.js';
import { normalizeVector } from '../embeddings/vectorMath.js';
import type { EmbeddingProvider } from '../embeddings/EmbeddingProvider.js';
import { isEmbeddingInputTooLargeError } from '../embeddings/OpenAICompatibleEmbeddingProvider.js';
import type { LanceVectorStore } from '../vector-store/LanceVectorStore.js';
import type { ChunkRecord } from '../vector-store/schema.js';
import { createLogger } from '../utils/logger.js';
import { acquireLock } from './lock.js';
import { registryEntryFrom, upsertRegistryEntry } from './registry.js';
import { removeProgress, writeProgress, writeState, type IndexProgress } from './state.js';

const logger = createLogger('indexer');
/** Safety cap so one abnormally large file (e.g. a generated bundle that slipped past ignore rules) can't stall a run. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface IndexerDeps {
  repoRoot: string;
  repoId: string;
  config: CodeIntelConfig;
  vectorStore: LanceVectorStore;
  embeddingProvider: EmbeddingProvider;
  paths: RepoPaths;
}

export interface IndexSummary {
  filesDiscovered: number;
  filesIndexed: number;
  filesUnchanged: number;
  filesRenamed: number;
  filesDeleted: number;
  filesSkipped: number;
  chunksEmbedded: number;
  chunksReused: number;
  chunksDeleted: number;
  durationMs: number;
}

/** Discover -> hash-diff -> parse/chunk -> embed only what changed -> upsert (spec sections 11 & 14). */
export class Indexer {
  constructor(private readonly deps: IndexerDeps) {}

  async runFullIndex(): Promise<IndexSummary> {
    const started = Date.now();
    const release = acquireLock(this.deps.paths.lockFile);
    try {
      return await this.runUnlocked(started);
    } finally {
      release();
    }
  }

  private async runUnlocked(started: number): Promise<IndexSummary> {
    const { repoRoot, config, vectorStore } = this.deps;

    const discovered = await discoverFiles(repoRoot, {
      allowSensitiveFiles: config.security.allowSensitiveFiles,
      extraIgnorePatterns: config.ignore
    });
    const previousHashes = await vectorStore.getAllFileHashes();
    const currentPaths = new Set(discovered.map((f) => f.relativePath));
    const removedPaths = [...previousHashes.keys()].filter((p) => !currentPaths.has(p));
    const removedHashToPath = new Map<string, string>();
    for (const path of removedPaths) {
      const hash = previousHashes.get(path);
      if (hash) removedHashToPath.set(hash, path);
    }
    const handledRemoved = new Set<string>();

    const summary: IndexSummary = {
      filesDiscovered: discovered.length,
      filesIndexed: 0,
      filesUnchanged: 0,
      filesRenamed: 0,
      filesDeleted: 0,
      filesSkipped: 0,
      chunksEmbedded: 0,
      chunksReused: 0,
      chunksDeleted: 0,
      durationMs: 0
    };
    const progress: IndexProgress = {
      startedAt: new Date(started).toISOString(),
      updatedAt: new Date().toISOString(),
      filesDiscovered: discovered.length,
      filesProcessed: 0,
      filesIndexed: 0,
      filesSkipped: 0,
      chunksEmbedded: 0,
      embeddingModel: this.deps.embeddingProvider.modelName()
    };
    writeProgress(this.deps.paths.progressFile, progress);

    for (const file of discovered) {
      try {
        await this.processDiscoveredFile(file, previousHashes, removedHashToPath, handledRemoved, summary);
      } catch (error) {
        if (!isEmbeddingInputTooLargeError(error)) throw error;
        summary.filesSkipped++;
        logger.warn(`[SKIP] ${file.relativePath} exceeds the embedding model context window after chunking`);
      } finally {
        progress.updatedAt = new Date().toISOString();
        progress.filesProcessed++;
        progress.filesIndexed = summary.filesIndexed + summary.filesUnchanged + summary.filesRenamed;
        progress.filesSkipped = summary.filesSkipped;
        progress.chunksEmbedded = summary.chunksEmbedded;
        writeProgress(this.deps.paths.progressFile, progress);
      }
    }

    for (const oldPath of removedPaths) {
      if (handledRemoved.has(oldPath)) continue;
      await vectorStore.deleteByFile(oldPath);
      summary.filesDeleted++;
      logger.info(`[DELETE] ${oldPath}`);
    }

    await vectorStore.optimize();
    summary.durationMs = Date.now() - started;

    const filesInIndex = summary.filesIndexed + summary.filesUnchanged + summary.filesRenamed;
    const lastIndexedAt = new Date().toISOString();
    const embeddingModel = this.deps.embeddingProvider.modelName();
    const embeddingDimensions = await this.deps.embeddingProvider.dimensions();
    const chunksIndexed = await vectorStore.countRows();

    writeState(this.deps.paths.stateFile, {
      lastIndexedAt,
      lastDurationMs: summary.durationMs,
      filesIndexed: filesInIndex,
      chunksIndexed,
      embeddingModel,
      embeddingDimensions,
      repoRoot,
      repoName: basename(repoRoot),
      filesDiscovered: summary.filesDiscovered
    });

    upsertRegistryEntry(
      this.deps.config.database.path,
      registryEntryFrom(repoRoot, this.deps.repoId, {
        lastIndexedAt,
        filesIndexed: filesInIndex,
        chunksIndexed,
        embeddingModel
      })
    );
    removeProgress(this.deps.paths.progressFile);

    logger.info('[DONE]', { ...summary });
    return summary;
  }

  private async processDiscoveredFile(
    file: DiscoveredFile,
    previousHashes: Map<string, string>,
    removedHashToPath: Map<string, string>,
    handledRemoved: Set<string>,
    summary: IndexSummary
  ): Promise<void> {
    let sizeBytes: number;
    try {
      sizeBytes = statSync(file.absolutePath).size;
    } catch {
      return; // vanished between discovery and processing
    }
    if (sizeBytes > MAX_FILE_BYTES) {
      logger.warn(`[SKIP] ${file.relativePath} exceeds ${MAX_FILE_BYTES}-byte safety cap`);
      summary.filesSkipped++;
      return;
    }

    let buffer: Buffer;
    try {
      buffer = await readFile(file.absolutePath);
    } catch (error) {
      logger.warn(`[SKIP] ${file.relativePath} could not be read`, {
        error: error instanceof Error ? error.message : String(error)
      });
      summary.filesSkipped++;
      return;
    }

    if (looksBinary(buffer)) {
      summary.filesSkipped++;
      return;
    }

    const content = buffer.toString('utf-8');
    if (containsLikelySecret(content)) {
      logger.warn(`[SKIP] ${file.relativePath} looks like it contains a secret value`);
      summary.filesSkipped++;
      return;
    }

    const fileHash = hashFileContent(buffer);
    const previousHash = previousHashes.get(file.relativePath);

    if (previousHash !== undefined) {
      if (previousHash === fileHash) {
        summary.filesUnchanged++;
        return;
      }
      await this.indexFileContent(file, content, fileHash, summary);
      return;
    }

    const renameFrom = removedHashToPath.get(fileHash);
    if (renameFrom !== undefined) {
      await this.deps.vectorStore.renameFile(renameFrom, file.relativePath, file.absolutePath);
      removedHashToPath.delete(fileHash);
      handledRemoved.add(renameFrom);
      summary.filesRenamed++;
      logger.info(`[RENAME] ${renameFrom} -> ${file.relativePath}`);
      return;
    }

    await this.indexFileContent(file, content, fileHash, summary);
  }

  private async indexFileContent(
    file: DiscoveredFile,
    content: string,
    fileHash: string,
    summary: IndexSummary
  ): Promise<void> {
    const { repoId, embeddingProvider, vectorStore, config } = this.deps;
    logger.info(`[INDEX] ${file.relativePath} changed`);

    const { language, chunks } = await chunkFile(content, file.relativePath, config.indexing);
    const existing = await vectorStore.getChunksForFile(file.relativePath);
    const existingById = new Map(existing.map((e) => [e.id, e]));

    const now = new Date().toISOString();
    const newIds = new Set<string>();
    const records: ChunkRecord[] = [];
    const pendingEmbedIndexes: number[] = [];
    const pendingEmbedTexts: string[] = [];

    chunks.forEach((chunk, index) => {
      const id = computeChunkId(
        repoId,
        file.relativePath,
        chunk.parentSymbol ?? '',
        chunk.symbolType ?? 'text',
        chunk.symbolName ?? `#${index}`
      );
      newIds.add(id);
      const contentHash = hashChunkContent(chunk.content);
      const prior = existingById.get(id);
      const reused = prior !== undefined && prior.contentHash === contentHash;

      records.push({
        id,
        repo_id: repoId,
        file_path: file.relativePath,
        absolute_path: file.absolutePath,
        language,
        symbol_name: chunk.symbolName,
        symbol_type: chunk.symbolType,
        parent_symbol: chunk.parentSymbol,
        start_line: chunk.startLine,
        end_line: chunk.endLine,
        content: chunk.content,
        content_hash: contentHash,
        file_hash: fileHash,
        embedding: reused && prior ? prior.embedding : [],
        last_indexed_at: now,
        git_commit: null,
        extra_metadata: null
      });

      if (!reused) {
        pendingEmbedIndexes.push(records.length - 1);
        pendingEmbedTexts.push(chunk.content);
      }
    });

    if (pendingEmbedTexts.length > 0) {
      const vectors = await embeddingProvider.embedBatch(pendingEmbedTexts);
      pendingEmbedIndexes.forEach((recordIndex, i) => {
        const vector = vectors[i];
        const record = records[recordIndex];
        if (vector && record) record.embedding = normalizeVector(vector);
      });
    }

    const staleIds = [...existingById.keys()].filter((id) => !newIds.has(id));
    if (staleIds.length > 0) await vectorStore.deleteByIds(staleIds);
    if (records.length > 0) await vectorStore.upsertChunks(records);

    summary.filesIndexed++;
    summary.chunksReused += records.length - pendingEmbedTexts.length;
    summary.chunksEmbedded += pendingEmbedTexts.length;
    summary.chunksDeleted += staleIds.length;

    logger.info(`[CHUNK] ${chunks.length} chunks generated`, {
      reused: records.length - pendingEmbedTexts.length,
      embedded: pendingEmbedTexts.length,
      deleted: staleIds.length
    });
  }
}
