import { IndexerLockedError } from '../indexer/lock.js';
import { OllamaModelNotFoundError, OllamaNotReachableError } from '../embeddings/OllamaEmbeddingProvider.js';
import {
  EmbeddingConfigurationError,
  OpenAICompatibleEmbeddingError
} from '../embeddings/OpenAICompatibleEmbeddingProvider.js';

function stepsFor(error: unknown, message: string): string[] {
  if (
    error instanceof EmbeddingConfigurationError &&
    /CODE_INTEL_EMBEDDING_API_KEY is required/i.test(message)
  ) {
    return [
      'Export the key in this shell (Cursor MCP env is not inherited by your terminal):',
      '    export CODE_INTEL_EMBEDDING_API_KEY=…',
      '    export CODE_INTEL_EMBEDDING_USER=…   # only if the company proxy requires a user',
      'Then re-run the command.',
      'Or run `code-intel wizard` / `code-intel corporate-setup` to enter the key for this session (it is not written to YAML).',
      'Or switch to local Ollama: `code-intel index --embedding-provider ollama --embedding-model nomic-embed-text` (run `code-intel rebuild` if the index was built with a different model).',
      'Confirm with `code-intel doctor`.'
    ];
  }

  if (error instanceof EmbeddingConfigurationError && /base_url is required/i.test(message)) {
    return [
      'Set embedding.base_url in `.code-intel/config.yaml` or `CODE_INTEL_EMBEDDING_BASE_URL`.',
      'Or pass `--embedding-base-url https://your-proxy.example`.',
      'Or switch to Ollama: `--embedding-provider ollama`.',
      'Confirm with `code-intel doctor`.'
    ];
  }

  if (error instanceof OpenAICompatibleEmbeddingError) {
    if (error.status === 401 || error.status === 403 || /rejected the credentials/i.test(message)) {
      return [
        'Check `CODE_INTEL_EMBEDDING_API_KEY` (and `CODE_INTEL_EMBEDDING_USER` if the proxy requires it).',
        'Keys are never read from YAML — they must be in the environment of this process.',
        'Run `code-intel doctor` after exporting the variables.'
      ];
    }
    if (error.status === 404 || /was not found \(404\)/i.test(message)) {
      return [
        'Check `embedding.base_url`, `embedding.embeddings_path`, and `embedding.model` in `.code-intel/config.yaml`.',
        'Override with `--embedding-base-url` / `--embedding-model` if needed.',
        'Run `code-intel doctor` to probe the endpoint.'
      ];
    }
    if (/Cannot reach embedding proxy/i.test(message)) {
      return [
        'Check network / VPN access to the embedding proxy.',
        'If this is a corporate proxy, set `embedding.use_system_ca: true` and use a Node that supports `--use-system-ca`.',
        'Run `code-intel doctor` to retry the probe.'
      ];
    }
    if (error.status === 408 || error.status === 503 || /Timeout|temporarily unavailable|timed out/i.test(message)) {
      return [
        'Retry in a minute — the proxy may be overloaded or timing out.',
        'If this keeps happening, raise `embedding.timeout_ms` in `.code-intel/config.yaml`.',
        'Or switch to local Ollama: `--embedding-provider ollama --embedding-model nomic-embed-text` (then `code-intel rebuild`).',
        'Confirm with `code-intel doctor`.'
      ];
    }
  }

  if (error instanceof OllamaNotReachableError || /Cannot reach Ollama/i.test(message)) {
    return [
      'Start Ollama: `ollama serve`.',
      'Or point at a running host: `--embedding-host http://127.0.0.1:11434`.',
      'If you meant the company proxy, this repo’s `.code-intel/config.yaml` should keep `provider: openai-compatible` and you must export `CODE_INTEL_EMBEDDING_API_KEY`.',
      'Run `code-intel doctor`.'
    ];
  }

  if (error instanceof OllamaModelNotFoundError || /is not available locally/i.test(message)) {
    return [
      'Pull the model: `ollama pull <model>` or `code-intel doctor --fix`.',
      'Or set `embedding.model` / `--embedding-model` to a model you already have.'
    ];
  }

  if (error instanceof IndexerLockedError || /already indexing this repository/i.test(message)) {
    return [
      'Wait for the other `code-intel index`, `watch`, or MCP watcher to finish.',
      'If that process is dead, delete the `.lock` file under the repo’s index directory (`code-intel status` prints Index location) and retry.'
    ];
  }

  if (/index was built with embedding model/i.test(message)) {
    return [
      'Run `code-intel rebuild` to re-embed with the currently configured model.',
      'Or pass `--embedding-model` matching the model shown in `code-intel status`.'
    ];
  }

  if (/Index directory is not writable/i.test(message) || /EACCES|EROFS|EPERM/i.test(message)) {
    return [
      'Check permissions on the index directory (`code-intel status` prints Index location).',
      'If the path is on a read-only volume, set `database.path` in `.code-intel/config.yaml` to a writable location.',
      'Retry after fixing ownership (`chown`) or disk space.'
    ];
  }

  if (/not indexed|No indexed repository matches|code-intel setup --repo/i.test(message)) {
    return [
      'Index this repo: `code-intel setup --repo <path>` (or `code-intel index` if setup already ran).',
      'If embeddings fail, export `CODE_INTEL_EMBEDDING_API_KEY` first (keys are never stored in YAML).',
      'Confirm with `code-intel doctor` and `code-intel status`.'
    ];
  }

  return ['Run `code-intel doctor` for a full diagnosis of the embedding provider and index.'];
}

/** Recovery steps for a CLI or MCP failure (no FAIL prefix). */
export function recoverySteps(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error);
  return stepsFor(error, message);
}

/** Multi-line CLI failure: diagnosis plus concrete recovery steps. */
export function formatCliFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const steps = recoverySteps(error);
  const body = steps.map((step, index) => `  ${index + 1}. ${step}`).join('\n');
  return `[FAIL] ${message}\n\nWhat you can do:\n${body}`;
}
