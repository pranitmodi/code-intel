# Security policy

## Supported versions

Security fixes are applied to the latest published npm version. Upgrade before reporting an issue that may already be fixed.

## Reporting a vulnerability

Do not open a public issue for a vulnerability, leaked credential, or private source exposure.

Use [GitHub private vulnerability reporting](https://github.com/pranitmodi/code-intel/security/advisories/new). Include:

- affected version or commit;
- operating system and Node.js version;
- embedding provider type, without credentials;
- reproduction steps;
- expected impact;
- whether private source or secrets may have left the machine.

You should receive an acknowledgement within seven days. Please allow reasonable time for investigation and a coordinated fix before public disclosure.

## Security model

`code-intel` reads source files, sends text to an embedding provider, and stores source chunks and vectors in a local LanceDB index.

### Default Ollama mode

- Source chunks and queries are sent only to the configured Ollama host.
- The default host is local.
- Source chunks, vectors, metadata, usage events, and repository paths are stored under `~/.local-code-intelligence`.
- No telemetry is enabled by default.

Treat a non-local Ollama host as a remote service.

### OpenAI-compatible mode

- Source chunks are sent to the configured embeddings endpoint during indexing.
- Search queries are sent to that endpoint during semantic retrieval.
- Embeddings and LanceDB remain local.
- API keys and optional user identities are read from environment variables. They are not read from YAML or written to the index.

Review the endpoint's retention, training, and access policies before indexing private source.

## Source filtering

By default, discovery excludes:

- `.env*` and common credential files;
- private keys and certificates;
- dependency, build, VCS, and cache directories;
- binary files;
- files containing likely secret values;
- files above the indexer safety cap.

These controls reduce risk but are not a substitute for repository access control or secret scanning. False negatives are possible. Do not index source that the configured embedding provider is not allowed to receive.

## Local files to protect

Protect these as developer data:

```text
~/.cursor/mcp.json
~/.local-code-intelligence/config.yaml
~/.local-code-intelligence/registry.json
~/.local-code-intelligence/usage.jsonl
~/.local-code-intelligence/repos/
```

MCP configuration may contain embedding credentials. Repository indexes contain source text. Do not upload either directory in bug reports.

## Operational guidance

- Prefer Ollama for private, local-only operation.
- Use environment variables or a secret manager for provider credentials.
- Never commit `.code-intel/config.yaml` if it contains organization-specific endpoints or identities.
- Rotate credentials immediately if they appear in terminal output, logs, screenshots, issues, or chat transcripts.
- Run `code-intel clean --repo <path>` before decommissioning a workstation or transferring a repository index.
- Keep Node.js and dependencies current, and review `npm audit` before releases.

## Out of scope

Reports requiring physical access to an unlocked developer machine, social engineering, or denial of service through intentionally enormous trusted repositories may be closed unless they demonstrate a concrete boundary bypass.
