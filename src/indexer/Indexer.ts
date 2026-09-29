import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { CodeIntelConfig } from '../config/types.js';
import type { RepoPaths } from '../config/paths.js';
import { discoverFiles, type DiscoveredFile } from '../discovery/discover.js';
import { looksBinary } from '../discovery/binary-check.js';
import { containsLikelySecret } from '../discovery/secret-scan.js';
import { chunkFile } from '../chunker/chunker.js';
import { buildChunkExtraMetadata, chunkerVersionOf, serializeChunkExtraMetadata } from '../chunker/chunkMetadata.js';
import { CHUNKER_VERSION } from '../chunker/version.js';
import { computeChunkId, hashChunkContent, hashFileContent } from '../hashing/hash.js';
import { normalizeVector } from '../embeddings/vectorMath.js';
import type { EmbeddingProvider } from '../embeddings/EmbeddingProvider.js';
import { isEmbeddingInputTooLargeError } from '../embeddings/OpenAICompatibleEmbeddingProvider.js';
import type { LanceVectorStore } from '../vector-store/LanceVectorStore.js';
import type { ChunkRecord } from '../vector-store/schema.js';
import { createLogger } from '../utils/logger.js';
import { mapPool, Mutex } from '../utils/pool.js';
import { acquireLock } from './lock.js';
import { registryEntryFrom, upsertRegistryEntry } from './registry.js';
import { computeSampleFingerprint, pickSamplePaths } from './freshness.js';
import { readState, removeProgress, writeProgress, writeState, type IndexProgress, type IndexState } from './state.js';

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

/**
 * A directory moved or deleted as a whole arrives as one event for the
 * directory itself, so expand it to the indexed files beneath it.
 */
export function expandDeletedPaths(deletedPaths: string[], indexedPaths: Map<string, string>): string[] {
  const expanded = new Set<string>();
  for (const path of deletedPaths) {
    if (!path) continue;
    expanded.add(path);
    if (indexedPaths.has(path)) continue;
    const prefix = `${path.replace(/\/+$/, '')}/`;
    for (const indexed of indexedPaths.keys()) {
      if (indexed.startsWith(prefix)) expanded.add(indexed);
    }
  }
  return [...expanded];
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
/**
 * Watcher runs fold their rows into the indexes this often. Search still sees
 * unindexed rows, but by scanning them, so a long session of small edits
 * would otherwise slow every query a little more.
 */
const OPTIMIZE_EVERY_CHANGED_RUNS = 20;
const OPTIMIZE_EVERY_MS = 10 * 60 * 1000;

export class Indexer {
  private readonly storeLock = new Mutex();
  private changedRunsSinceOptimize = 0;
  private lastOptimizedAt = Date.now();

  constructor(private readonly deps: IndexerDeps) {}

  async runFullIndex(): Promise<IndexSummary> {
    const started = Date.now();
    const release = acquireLock(this.deps.paths.lockFile);
    try {
      await this.deps.vectorStore.syncLatest();
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

    await mapPool(discovered, this.deps.config.indexing.concurrency, async (file) => {
      try {
        await this.processDiscoveredFile(file, previousHashes, removedHashToPath, handledRemoved, summary);
      } catch (error) {
        if (!isEmbeddingInputTooLargeError(error)) throw error;
        await this.storeLock.run(() => {
          summary.filesSkipped++;
        });
        logger.warn(`[SKIP] ${file.relativePath} exceeds the embedding model context window after chunking`);
      } finally {
        await this.storeLock.run(() => {
          progress.updatedAt = new Date().toISOString();
          progress.filesProcessed++;
          progress.filesIndexed = summary.filesIndexed + summary.filesUnchanged + summary.filesRenamed;
          progress.filesSkipped = summary.filesSkipped;
          progress.chunksEmbedded = summary.chunksEmbedded;
          writeProgress(this.deps.paths.progressFile, progress);
        });
      }
    });

    for (const oldPath of removedPaths) {
      if (handledRemoved.has(oldPath)) continue;
      await vectorStore.deleteByFile(oldPath);
      summary.filesDeleted++;
      logger.info(`[DELETE] ${oldPath}`);
    }

    await vectorStore.optimize();
    this.changedRunsSinceOptimize = 0;
    this.lastOptimizedAt = Date.now();
    summary.durationMs = Date.now() - started;

    const filesInIndex = summary.filesIndexed + summary.filesUnchanged + summary.filesRenamed;
    await this.persistState(summary, {
      filesIndexed: filesInIndex,
      filesDiscovered: summary.filesDiscovered,
      samplePaths: pickSamplePaths(discovered.map((file) => file.relativePath))
    });
    removeProgress(this.deps.paths.progressFile);

    logger.info('[DONE]', { ...summary });
    return summary;
  }

  /**
   * Index or delete specific relative paths without walking the whole tree.
   * Used by the file watcher. Callers should fall back to `runFullIndex` for large bursts.
   */
  async runChangedPaths(relativePaths: string[], deletedPaths: string[] = []): Promise<IndexSummary> {
    const started = Date.now();
    const release = acquireLock(this.deps.paths.lockFile);
    try {
      const { repoRoot, vectorStore } = this.deps;
      await vectorStore.syncLatest();
      const previousHashes = await vectorStore.getAllFileHashes();
      const previous = readState(this.deps.paths.stateFile);
      const removedHashToPath = new Map<string, string>();
      const handledRemoved = new Set<string>();
      const summary: IndexSummary = {
        filesDiscovered: previous?.filesDiscovered ?? previousHashes.size,
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

      const uniqueDeletes = expandDeletedPaths(deletedPaths, previousHashes);
      for (const relativePath of uniqueDeletes) {
        await vectorStore.deleteByFile(relativePath);
        summary.filesDeleted++;
        logger.info(`[DELETE] ${relativePath}`);
      }

      const uniqueUpserts = [...new Set(relativePaths.filter((path) => path && !uniqueDeletes.includes(path)))];
      for (const relativePath of uniqueUpserts) {
        const file: DiscoveredFile = {
          relativePath,
          absolutePath: join(repoRoot, ...relativePath.split('/'))
        };
        try {
          await this.processDiscoveredFile(file, previousHashes, removedHashToPath, handledRemoved, summary);
        } catch (error) {
          if (!isEmbeddingInputTooLargeError(error)) throw error;
          summary.filesSkipped++;
          logger.warn(`[SKIP] ${relativePath} exceeds the embedding model context window after chunking`);
        }
      }

      this.changedRunsSinceOptimize += 1;
      const written = summary.filesIndexed + summary.filesDeleted + summary.filesRenamed > 0;
      if (
        written &&
        (this.changedRunsSinceOptimize >= OPTIMIZE_EVERY_CHANGED_RUNS || Date.now() - this.lastOptimizedAt >= OPTIMIZE_EVERY_MS)
      ) {
        await vectorStore.optimize();
        this.changedRunsSinceOptimize = 0;
        this.lastOptimizedAt = Date.now();
      }

      summary.durationMs = Date.now() - started;
      const newFileCount = uniqueUpserts.filter((path) => !previousHashes.has(path)).length;
      const deletedIndexedCount = uniqueDeletes.filter((path) => previousHashes.has(path)).length;
      const netFiles = (previous?.filesIndexed ?? previousHashes.size) + newFileCount - deletedIndexedCount;
      const filesDiscovered = Math.max(
        0,
        (previous?.filesDiscovered ?? previousHashes.size) + newFileCount - deletedIndexedCount
      );
      const remaining = [...previousHashes.keys(), ...uniqueUpserts].filter((path) => !uniqueDeletes.includes(path));
      const keptSample = previous?.samplePaths?.filter((path) => !uniqueDeletes.includes(path)) ?? [];
      const samplePaths = keptSample.length > 0 ? keptSample : pickSamplePaths(remaining);
      await this.persistState(summary, {
        filesIndexed: Math.max(0, netFiles),
        filesDiscovered,
        samplePaths
      });
      return summary;
    } finally {
      release();
    }
  }

  private async persistState(
    summary: IndexSummary,
    counts: { filesIndexed: number; filesDiscovered: number; samplePaths: string[] }
  ): Promise<void> {
    const { repoRoot, vectorStore } = this.deps;
    const lastIndexedAt = new Date().toISOString();
    const embeddingModel = this.deps.embeddingProvider.modelName();
    const embeddingDimensions = await this.deps.embeddingProvider.dimensions();
    const chunksIndexed = await vectorStore.countRows();
    const sampleFingerprint = computeSampleFingerprint(repoRoot, counts.samplePaths) ?? undefined;
    const state: IndexState = {
      lastIndexedAt,
      lastDurationMs: summary.durationMs,
      filesIndexed: counts.filesIndexed,
      chunksIndexed,
      embeddingModel,
      embeddingDimensions,
      repoRoot,
      repoName: basename(repoRoot),
      filesDiscovered: counts.filesDiscovered,
      samplePaths: counts.samplePaths,
      sampleFingerprint
    };
    writeState(this.deps.paths.stateFile, state);
    upsertRegistryEntry(
      this.deps.config.database.path,
      registryEntryFrom(repoRoot, this.deps.repoId, {
        lastIndexedAt,
        filesIndexed: counts.filesIndexed,
        chunksIndexed,
        embeddingModel
      })
    );
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
      await this.storeLock.run(() => {
        summary.filesSkipped++;
      });
      return;
    }

    let buffer: Buffer;
    try {
      buffer = await readFile(file.absolutePath);
    } catch (error) {
      logger.warn(`[SKIP] ${file.relativePath} could not be read`, {
        error: error instanceof Error ? error.message : String(error)
      });
      await this.storeLock.run(() => {
        summary.filesSkipped++;
      });
      return;
    }

    if (looksBinary(buffer)) {
      await this.storeLock.run(() => {
        summary.filesSkipped++;
      });
      return;
    }

    const content = buffer.toString('utf-8');
    if (containsLikelySecret(content)) {
      logger.warn(`[SKIP] ${file.relativePath} looks like it contains a secret value`);
      await this.storeLock.run(() => {
        summary.filesSkipped++;
      });
      return;
    }

    const fileHash = hashFileContent(buffer);
    const decision = await this.storeLock.run(async (): Promise<'unchanged' | 'rename' | 'index'> => {
      const previousHash = previousHashes.get(file.relativePath);

      if (previousHash !== undefined) {
        if (previousHash === fileHash) {
          const existing = await this.deps.vectorStore.getChunksForFile(file.relativePath);
          // Unchanged content still needs re-chunking when an older chunker produced it.
          const outdated = existing.some(
            (chunk) => !chunk.extraMetadata || chunkerVersionOf(chunk.extraMetadata) < CHUNKER_VERSION
          );
          if (!outdated) {
            summary.filesUnchanged++;
            return 'unchanged';
          }
        }
        return 'index';
      }

      const renameFrom = removedHashToPath.get(fileHash);
      if (renameFrom !== undefined) {
        await this.deps.vectorStore.renameFile(renameFrom, file.relativePath, file.absolutePath);
        removedHashToPath.delete(fileHash);
        handledRemoved.add(renameFrom);
        summary.filesRenamed++;
        logger.info(`[RENAME] ${renameFrom} -> ${file.relativePath}`);
        return 'rename';
      }

      return 'index';
    });

    if (decision !== 'index') return;

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
    const existing = await this.storeLock.run(() => vectorStore.getChunksForFile(file.relativePath));
    const existingById = new Map(existing.map((e) => [e.id, e]));
    // Chunks whose text is unchanged keep their embedding even when their id
    // changes (a block that moved, or a re-chunk after a chunker upgrade).
    const embeddingByHash = new Map(existing.map((e) => [e.contentHash, e.embedding]));

    const now = new Date().toISOString();
    const newIds = new Set<string>();
    const records: ChunkRecord[] = [];
    const pendingEmbedIndexes: number[] = [];
    const pendingEmbedTexts: string[] = [];
    const occurrences = new Map<string, number>();

    chunks.forEach((chunk, index) => {
      const contentHash = hashChunkContent(chunk.content);
      const identity: string[] = [
        chunk.parentSymbol ?? '',
        chunk.symbolType ?? 'text',
        // An unnamed block is identified by its text, so inserting code above it keeps its id.
        chunk.symbolName ?? (chunk.symbolType === 'block' ? `h:${contentHash.slice(0, 16)}` : `#${index}`)
      ];
      // Same-named siblings (overloads, repeated headings) share a symbol identity. LanceDB rejects a
      // merge batch holding two rows with one key, so repeats are suffixed; the first keeps the bare
      // id to stay reusable against indexes built before this.
      const repeat = occurrences.get(identity.join(':')) ?? 0;
      occurrences.set(identity.join(':'), repeat + 1);
      const id = computeChunkId(
        repoId,
        file.relativePath,
        ...(repeat === 0 ? identity : [...identity, `@${repeat}`])
      );
      newIds.add(id);
      const prior = existingById.get(id);
      const reusedEmbedding =
        prior !== undefined && prior.contentHash === contentHash ? prior.embedding : embeddingByHash.get(contentHash);
      const reused = reusedEmbedding !== undefined && reusedEmbedding.length > 0;

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
        embedding: reused ? reusedEmbedding : [],
        last_indexed_at: now,
        git_commit: null,
        extra_metadata: serializeChunkExtraMetadata(
          buildChunkExtraMetadata(file.relativePath, content, chunk.content, language, {
            ...chunk.meta,
            v: CHUNKER_VERSION
          })
        )
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
    await this.storeLock.run(async () => {
      if (staleIds.length > 0) await vectorStore.deleteByIds(staleIds);
      if (records.length > 0) await vectorStore.upsertChunks(records);

      summary.filesIndexed++;
      summary.chunksReused += records.length - pendingEmbedTexts.length;
      summary.chunksEmbedded += pendingEmbedTexts.length;
      summary.chunksDeleted += staleIds.length;
    });

    logger.info(`[CHUNK] ${chunks.length} chunks generated`, {
      reused: records.length - pendingEmbedTexts.length,
      embedded: pendingEmbedTexts.length,
      deleted: staleIds.length
    });
  }
}
