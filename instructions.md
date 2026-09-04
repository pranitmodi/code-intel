# Build a Local Persistent Code Intelligence Server

I want you to build a **local-first semantic code indexing and retrieval system** for software repositories.

The goal is to create a reusable local service that indexes an entire codebase into a **local vector database**, continuously keeps that index synchronized with the repository as files change, and exposes semantic code search to AI coding agents through **MCP**.

The important architectural principle is:

> **Index and embed the repository once locally, then allow multiple AI agents/IDEs to query the same persistent local index instead of independently re-vectorizing or repeatedly indexing the repository.**

The system should work independently of any particular AI IDE. Cursor, VS Code/Continue, Claude Code, Codex, or a custom agent should be able to query the same local code intelligence service.

---

# 1. Core Architecture

Build the system around this architecture:

```text
                         ┌──────────────────────┐
                         │      Git Repo        │
                         └──────────┬───────────┘
                                    │
                              File Watcher
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │ Incremental Indexer  │
                         │                      │
                         │ - detect changes    │
                         │ - parse files        │
                         │ - chunk code        │
                         │ - hash chunks       │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │ Local Embedding      │
                         │ Model                │
                         │                      │
                         │ Ollama / local model│
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │ Local Vector DB      │
                         │                      │
                         │ LanceDB preferred    │
                         └──────────┬───────────┘
                                    │
                         ┌──────────┴───────────┐
                         │                      │
                         ▼                      ▼
                  Semantic Search          Symbol Search
                         │                      │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │ MCP Server           │
                         │                      │
                         │ search_codebase()    │
                         │ search_symbol()      │
                         │ get_file_context()   │
                         │ get_repo_context()   │
                         └──────────┬───────────┘
                                    │
                 ┌──────────────────┼──────────────────┐
                 │                  │                  │
                 ▼                  ▼                  ▼
              Cursor            Claude Code          Codex
```

The vector database, embeddings, metadata, and indexes must remain **on the user's machine**.

Do not require a cloud vector database.

Do not require sending the source code to a third-party indexing service.

---

# 2. Primary Requirements

The system must:

1. Index an existing repository.
2. Store embeddings locally.
3. Store the vector database locally.
4. Watch the repository for changes.
5. Incrementally update only affected files/chunks.
6. Avoid re-embedding unchanged code.
7. Support semantic search.
8. Support exact/symbol-based search.
9. Return file paths and precise line ranges.
10. Preserve enough metadata to reconstruct useful code context.
11. Expose search through MCP.
12. Allow multiple AI agents to query the same index.
13. Work without requiring a particular IDE.
14. Have a CLI for manual operation.
15. Have clear logs and diagnostics.
16. Handle large repositories efficiently.
17. Respect `.gitignore` and configurable ignore patterns.
18. Never index secrets or sensitive files by default.
19. Be deterministic and recoverable.
20. Have tests for indexing, updates, deletion, search, and MCP functionality.

---

# 3. Local-First Requirement

This is extremely important.

The following must be local by default:

* source code indexing
* source code parsing
* chunking
* hashing
* embeddings
* vector database
* metadata database
* file watching
* search

The embedding model should preferably run through **Ollama** or another local inference runtime.

Design the embedding provider behind an interface so that it can later support:

```text
Ollama
Local Transformers
OpenAI-compatible API
Other embedding providers
```

But the default configuration must be local.

The system should continue to work without an internet connection after the required model/dependencies have been installed.

---

# 4. Vector Database

Use **LanceDB** as the default local vector database unless there is a compelling technical reason not to.

The database should live somewhere like:

```text
.project-intelligence/
    db/
    metadata/
    config.json
    state.json
    logs/
```

or preferably in a global user directory with repository-specific indexes:

```text
~/.local-code-intelligence/
    repos/
        <repo-id>/
            db/
            metadata/
            state.json
```

Allow the user to configure the storage location.

Do not put generated vector data into Git.

Automatically add the local index directory to `.gitignore` if it is inside the repository.

---

# 5. Repository Identification

Each repository should have a stable identifier.

Prefer something deterministic such as:

```text
normalized repository root path
```

hashed into a stable ID.

Example:

```text
/home/user/projects/my-app
```

becomes:

```text
a8f1c3...
```

This prevents different repositories from accidentally sharing indexes.

Support multiple repositories simultaneously.

---

# 6. File Discovery

Recursively discover files in the repository.

Respect:

```text
.gitignore
```

and configurable ignore patterns.

Default exclusions should include things such as:

```text
.git/
node_modules/
dist/
build/
coverage/
.next/
target/
vendor/
.cache/
tmp/
*.lock
*.min.js
*.map
binary files
images
videos
archives
generated files
```

Do not blindly exclude configuration files. Files such as:

```text
package.json
tsconfig.json
docker-compose.yml
Dockerfile
pyproject.toml
Cargo.toml
go.mod
```

may contain important architectural context and should generally be indexed.

Allow users to override exclusions.

---

# 7. Secret Protection

Do NOT index obvious secrets by default.

Exclude files/patterns such as:

```text
.env
.env.*
*.pem
*.key
*.p12
*.pfx
credentials.*
secrets.*
```

Also consider detecting likely secret values before embedding.

The system should have a configuration option:

```text
allow_sensitive_files: false
```

Default it to false.

Never transmit repository contents anywhere by default.

---

# 8. Parsing

Use **Tree-sitter** or another robust syntax parser where practical.

The goal is to make chunks structurally meaningful.

Do not simply split every file every N characters.

For supported languages, understand constructs such as:

```text
classes
functions
methods
interfaces
types
structs
enums
imports
exports
constants
variables
modules
```

The chunking layer should be abstracted behind an interface:

```text
Parser
Chunker
```

so additional languages can be added later.

At minimum, support common languages such as:

```text
TypeScript
JavaScript
Python
Go
Rust
Java
C
C++
C#
Swift
Kotlin
Ruby
PHP
SQL
HTML
CSS
JSON
YAML
Markdown
Shell
```

For unsupported languages, fall back to intelligent text chunking.

---

# 9. Code Chunking

Each chunk should contain enough context to be independently useful to an LLM.

Example:

```text
File:
src/auth/AuthService.ts

Symbol:
AuthService.refreshToken

Lines:
82-127

Content:
...
```

Avoid tiny chunks that lose context.

Avoid massive chunks that waste context windows.

Use structural boundaries whenever possible.

A chunk should preferably correspond to:

```text
function
method
class
interface
type
module
configuration block
documentation section
```

For very large functions/classes, split them intelligently.

Support configurable:

```text
max_chunk_tokens
chunk_overlap
```

but prioritize structural boundaries over fixed token counts.

---

# 10. Metadata Schema

Each vector record should contain at minimum:

```text
id
repo_id
file_path
absolute_path
language
symbol_name
symbol_type
parent_symbol
start_line
end_line
content
content_hash
file_hash
embedding
last_indexed_at
git_commit
```

Potential additional metadata:

```text
imports
exports
dependencies
namespace
class_name
function_name
visibility
```

Design the schema so it can evolve without requiring a full rewrite.

---

# 11. Hash-Based Incremental Indexing

This is one of the most important requirements.

Do NOT re-embed an entire repository whenever anything changes.

Maintain hashes at both file and chunk level.

For example:

```text
file_hash = SHA256(file contents)
chunk_hash = SHA256(normalized chunk contents)
```

When a file changes:

1. Detect the changed file.
2. Re-read it.
3. Parse it.
4. Re-chunk it.
5. Calculate chunk hashes.
6. Compare against existing chunks.
7. Delete chunks that disappeared.
8. Reuse embeddings for unchanged chunks.
9. Generate embeddings only for new/changed chunks.
10. Insert/update the vector records.
11. Update metadata.

Example:

```text
auth.ts

100 chunks originally

Developer changes one function

After re-index:

99 chunks reused
1 chunk re-embedded
```

Do not embed the other 99 chunks again.

If chunk boundaries change because surrounding code changed, re-embed only the affected chunks.

---

# 12. File Watcher

Implement a persistent file watcher.

Use an appropriate cross-platform filesystem watcher.

Monitor:

```text
create
modify
delete
rename
```

When a file changes:

```text
filesystem event
       ↓
debounce
       ↓
determine repository
       ↓
check ignore rules
       ↓
incremental index
```

Use debouncing so saving a file multiple times quickly does not cause repeated embedding operations.

For example:

```text
500ms-1500ms debounce
```

Make this configurable.

---

# 13. Handling Deletes and Renames

If a file is deleted:

```text
delete all vectors belonging to that file
delete metadata
```

If a file is renamed:

Treat it intelligently.

Prefer:

```text
detect old file
detect new file
compare content hash
```

If the content is unchanged, update metadata/path without re-embedding.

---

# 14. Initial Indexing

Provide a command:

```bash
code-intel index
```

It should:

1. Discover files.
2. Display progress.
3. Parse files.
4. Generate chunks.
5. Generate embeddings.
6. Store vectors.
7. Store metadata.
8. Produce an indexing summary.

Example:

```text
Repository: my-app

Files discovered: 1,284
Files indexed: 913
Files ignored: 371

Chunks: 18,423
Embeddings generated: 18,423

Duration: 4m 12s

Index:
~/.local-code-intelligence/repos/abc123/
```

If indexing is interrupted, it should be resumable.

Do not lose all progress because the process was killed halfway through.

---

# 15. Search

Implement semantic search:

```bash
code-intel search "how does authentication refresh work?"
```

Return results such as:

```text
1. src/auth/AuthService.ts
   AuthService.refreshToken
   lines 82-127
   similarity: 0.91

2. src/api/ApiClient.ts
   ApiClient.request
   lines 44-91
   similarity: 0.87
```

The API should return structured JSON as well:

```json
{
  "results": [
    {
      "file": "src/auth/AuthService.ts",
      "symbol": "AuthService.refreshToken",
      "start_line": 82,
      "end_line": 127,
      "score": 0.91,
      "content": "..."
    }
  ]
}
```

---

# 16. Hybrid Search

Do not rely exclusively on vector similarity.

Implement hybrid retrieval combining:

```text
semantic/vector search
+
keyword search
+
symbol search
+
path matching
```

For example, a query:

```text
Where is UserRepository instantiated?
```

should be able to benefit from exact occurrences of:

```text
UserRepository
```

even if the semantic embedding isn't ideal.

Design a ranking layer that can combine:

```text
vector_score
keyword_score
symbol_score
path_score
```

into a final relevance score.

Keep the weighting configurable.

---

# 17. Symbol Search

Implement a separate symbol search capability:

```bash
code-intel symbol UserRepository
```

It should return:

```text
definitions
references where possible
file paths
line numbers
symbol hierarchy
```

This should not depend entirely on embeddings.

Use parsed AST information where available.

---

# 18. File Context Retrieval

Provide a tool to retrieve exact file context:

```text
get_file_context(
    file="src/auth/AuthService.ts",
    start_line=80,
    end_line=130
)
```

This is important because semantic search should identify the relevant area, while exact source retrieval should provide authoritative source content.

Do not make the vector database the only source of truth.

The repository itself remains authoritative.

---

# 19. Repository Context

Implement:

```text
get_repo_context()
```

It should provide a concise architectural overview derived from indexed metadata.

For example:

```text
Repository:
my-app

Languages:
TypeScript 72%
Python 18%
SQL 10%

Major directories:
src/api
src/auth
src/db
src/components

Important symbols:
...

Package managers:
...

Frameworks:
...
```

Do not generate a giant LLM-written summary by default.

Prefer deterministic metadata.

Optionally support generated summaries later.

---

# 20. MCP Server

Expose the system through **Model Context Protocol**.

Create an MCP server that provides tools such as:

```text
search_codebase
search_symbol
get_file_context
get_repo_context
find_references
```

Example:

```text
search_codebase(
    query="how does authentication refresh work?",
    limit=10
)
```

Return concise but useful results.

For each result include:

```text
file
symbol
line range
relevance
code
```

The MCP server should be able to run locally.

Example configuration conceptually:

```json
{
  "mcpServers": {
    "local-code-intelligence": {
      "command": "code-intel",
      "args": ["mcp"]
    }
  }
}
```

The exact configuration should follow the MCP client's current configuration conventions.

---

# 21. MCP Resources vs Tools

Prefer MCP tools for queries.

Potential tools:

```text
search_codebase
search_symbol
find_references
get_file_context
get_repo_context
```

Do not expose the entire repository as one giant resource.

The goal is efficient retrieval.

---

# 22. Multi-Agent Usage

Multiple agents should be able to query the same index concurrently.

Examples:

```text
Cursor
Claude Code
Codex
VS Code agent
Custom MCP client
```

The index should therefore be designed as shared infrastructure.

Reading/searching should be safe concurrently.

Index writes should use appropriate locking or transactional behavior.

If multiple indexers accidentally start, they should not corrupt the database.

Prefer one indexer per repository, with multiple read clients.

---

# 23. CLI

Build a clean CLI.

Suggested commands:

```bash
code-intel init
code-intel index
code-intel watch
code-intel search "query"
code-intel symbol "SymbolName"
code-intel file path/to/file.ts
code-intel status
code-intel doctor
code-intel rebuild
code-intel clean
code-intel mcp
```

`status` should display:

```text
Repository
Index location
Embedding provider
Embedding model
Files indexed
Chunks indexed
Last update
Watcher status
Database size
```

`doctor` should diagnose:

```text
Ollama availability
embedding model availability
database accessibility
filesystem watcher
permissions
configuration
```

---

# 24. Configuration

Support a config file such as:

```yaml
embedding:
  provider: ollama
  model: nomic-embed-text

database:
  path: ~/.local-code-intelligence

indexing:
  max_chunk_tokens: 800
  chunk_overlap: 100
  debounce_ms: 1000

search:
  default_limit: 10
  vector_weight: 0.7
  keyword_weight: 0.2
  symbol_weight: 0.1

security:
  allow_sensitive_files: false

ignore:
  - node_modules
  - dist
  - build
```

Environment variables may override configuration.

---

# 25. Embedding Provider Abstraction

Create an interface like:

```text
EmbeddingProvider
```

with methods conceptually equivalent to:

```text
embed(text)
embed_batch(texts)
dimensions()
model_name()
```

Implement:

```text
OllamaEmbeddingProvider
```

first.

The architecture should allow future providers without changing the indexing layer.

---

# 26. Batch Embedding

Do not make one network/runtime call per chunk when using Ollama.

Use batches.

For example:

```text
100 chunks
     ↓
batch into groups
     ↓
embedding provider
     ↓
vectors
```

Make batch size configurable.

Handle failures gracefully.

If one batch fails, retry that batch rather than restarting the entire indexing process.

---

# 27. Performance

Optimize for large repositories.

The system should be able to handle repositories containing:

```text
10k+ files
100k+ chunks
```

without keeping the entire repository in memory.

Use streaming/batched processing.

Avoid loading all embeddings into RAM unnecessarily.

Provide progress information.

---

# 28. Search Performance

Semantic searches should be fast enough for interactive agent usage.

Target:

```text
typical search < 500ms
```

where practical on a modern developer machine.

The embedding query itself may take additional time depending on the local model.

Cache embeddings for repeated queries where useful.

---

# 29. Query Embedding

When an agent asks:

```text
How does the payment retry system work?
```

only the **query** should need a fresh embedding.

The repository embeddings should already exist.

This is the central cost-saving mechanism.

Architecture:

```text
ONE TIME / INCREMENTAL:

code → embedding → local DB

PER QUERY:

question → embedding → local DB search → relevant code
```

Do not re-embed repository code during every query.

---

# 30. Context Optimization

Search should return enough context to answer the question without returning the entire repository.

Support:

```text
top_k
minimum_score
max_tokens
```

For example:

```text
search_codebase(
    query="how are payments retried?",
    limit=8,
    max_tokens=6000
)
```

The retrieval layer should stop once the context budget is reached.

---

# 31. Context Expansion

Implement optional context expansion.

If a highly relevant result is:

```text
AuthService.refreshToken()
```

the system should optionally retrieve:

```text
imports
parent class
related types
called functions
nearby code
```

This can dramatically improve agent usefulness.

Implement this as a separate retrieval stage rather than bloating every vector chunk.

---

# 32. Git Awareness

Where available, store:

```text
current git commit
branch
file status
```

Do not make Git a hard dependency.

The index should work in non-Git repositories too.

Potential future functionality:

```text
search_codebase(
    query="payment implementation",
    branch="feature/payments"
)
```

is not required initially.

---

# 33. Stale Index Detection

The system must be able to detect stale indexes.

For example:

```text
Index:
last indexed 15 minutes ago

Repository:
7 files changed since then
```

`status` should clearly indicate this.

If the watcher is not running, search should still work.

The system should optionally perform a lightweight consistency check before search.

---

# 34. Crash Recovery

The system must be resilient to:

```text
process termination
computer shutdown
embedding provider failure
database failure
partial indexing
```

Use transactions where possible.

Never leave the database in a state where half of an update is committed and metadata says otherwise.

Maintain indexing state.

---

# 35. Logging

Provide useful structured logs.

Example:

```text
[INDEX] src/auth/AuthService.ts changed
[PARSE] 17 symbols found
[CHUNK] 12 chunks generated
[REUSE] 10 existing embeddings
[EMBED] 2 new embeddings
[DB] updated 2 records
[DONE] 143ms
```

Avoid logging source code contents by default.

---

# 36. Privacy

Privacy is a core feature.

The system should make it obvious:

```text
Source code stays on this machine.
Embeddings stay on this machine.
Vector DB stays on this machine.
```

No telemetry by default.

No automatic cloud APIs.

No source-code uploads.

If a remote embedding provider is configured manually, display a warning that source content will leave the machine.

---

# 37. Tests

Write comprehensive automated tests.

At minimum:

### Indexing

* indexes repository
* ignores `.gitignore`
* ignores configured patterns
* indexes supported file types
* handles unsupported languages

### Incremental updates

* unchanged files are not re-embedded
* changed files are updated
* changed chunks are selectively re-embedded
* deleted files are removed
* renamed files don't cause unnecessary embedding
* rapid file changes are debounced

### Search

* semantic search returns relevant code
* keyword search works
* symbol search works
* hybrid ranking works
* line ranges are correct

### Database

* repository isolation
* persistence across restarts
* concurrent reads
* safe writes

### MCP

* server starts
* tools are exposed
* search tool returns correct schema
* file context retrieval works

### Failure cases

* Ollama unavailable
* malformed source
* binary files
* huge files
* database unavailable
* interrupted indexing

---

# 38. Developer Experience

Make installation simple.

Ideally:

```bash
npm install -g code-intel
```

or an equivalent package mechanism appropriate to the chosen language.

Then:

```bash
cd my-project

code-intel init
code-intel index
code-intel watch
```

The user should not need to understand vector databases, embeddings, or AST parsing.

---

# 39. Suggested Technology Stack

Unless you identify a strong reason otherwise, use:

```text
Language:
TypeScript or Python

Parsing:
Tree-sitter

Vector DB:
LanceDB

Embedding runtime:
Ollama

Default embedding model:
nomic-embed-text

Protocol:
MCP

File watching:
native/cross-platform filesystem watcher

Hashing:
SHA-256
```

Choose the language that gives the cleanest combination of:

* filesystem watching
* Tree-sitter support
* LanceDB support
* Ollama integration
* MCP support
* packaging
* cross-platform support

Explain the choice in the README.

---

# 40. Important Architectural Separation

Keep these components independent:

```text
File Discovery
      ↓
Parser
      ↓
Chunker
      ↓
Hasher
      ↓
Embedding Provider
      ↓
Vector Store
      ↓
Retriever
      ↓
MCP Server
      ↓
CLI
```

Do not create one giant indexing class.

Each component should have a clear interface.

This is important because I may later replace:

```text
LanceDB
```

with another database,

or:

```text
Ollama
```

with another embedding provider,

without rewriting the whole system.

---

# 41. Future-Proofing

Do not implement these unless they are needed for the MVP, but design the architecture so they are possible later:

### Cross-repository search

Search across:

```text
repo A
repo B
repo C
```

### Dependency graph

Understand:

```text
A → imports B → calls C
```

### Code relationship graph

Represent:

```text
functions
classes
files
imports
calls
references
```

### Automatic architecture summaries

Generate:

```text
architecture.md
```

from the indexed repository.

### IDE integrations

Possible extensions for:

```text
VS Code
Cursor
JetBrains
```

### Local reranking

Use a local reranker after vector retrieval.

### Multiple embedding models

Support model migration without destroying metadata.

---

# 42. MVP Scope

Do NOT over-engineer the first version.

The MVP must provide:

```text
1. Repository discovery
2. Tree-sitter parsing
3. Structural chunking
4. Local embeddings via Ollama
5. LanceDB storage
6. Hash-based incremental indexing
7. File watcher
8. Semantic search
9. Keyword/symbol search
10. MCP server
11. CLI
12. Tests
```

Everything else can follow.

---

# 43. Deliverables

Produce:

```text
/README.md

/src
    /indexer
    /parser
    /chunker
    /embeddings
    /vector-store
    /search
    /watcher
    /mcp
    /cli
    /config
    /utils

/tests

/examples

/package.json
```

Adapt the structure to the selected language.

README must include:

1. What the project does.
2. Architecture diagram.
3. Installation.
4. Ollama setup.
5. Initial indexing.
6. Running the watcher.
7. CLI usage.
8. MCP configuration.
9. Database location.
10. Privacy guarantees.
11. Configuration.
12. Troubleshooting.
13. Performance considerations.
14. Development instructions.

---

# 44. Acceptance Test

After implementation, create a small test repository:

```text
test-repo/
    auth.ts
    users.ts
    payments.ts
    database.ts
```

Index it.

Then verify:

```text
code-intel search "how does authentication work?"
```

returns `auth.ts`.

Then modify one function in `auth.ts`.

Verify:

```text
- auth.ts is detected
- only affected chunks are re-embedded
- unrelated files are untouched
- search immediately reflects the new code
```

Then delete:

```text
payments.ts
```

Verify its vectors disappear.

Then restart the service.

Verify the index persists.

Then connect through MCP and verify an external AI agent can call:

```text
search_codebase
get_file_context
search_symbol
```

without independently indexing or embedding the repository.

---

# 45. Most Important Success Criterion

The final system should demonstrate this exact behavior:

```text
              FIRST RUN

Repository
    ↓
Parse
    ↓
Chunk
    ↓
Embed locally
    ↓
LanceDB
```

Then:

```text
              NORMAL DEVELOPMENT

Developer edits code
       ↓
File watcher
       ↓
Detect changed chunks
       ↓
Embed ONLY changed chunks
       ↓
Update local DB
```

And when an AI agent asks:

```text
"How does authentication work?"
```

the flow must be:

```text
Agent
  ↓
MCP
  ↓
Local Code Intelligence Server
  ↓
Embed ONLY the query
  ↓
Search existing local vectors
  ↓
Hybrid ranking
  ↓
Retrieve relevant source
  ↓
Return context to agent
```

NOT:

```text
Agent
  ↓
Scan repository
  ↓
Re-chunk repository
  ↓
Re-embed repository
  ↓
Search
```

The repository embeddings must be **persistent and reusable across agent sessions and across different AI clients**.

---

# 46. Implementation Instructions

Before writing code:

1. Inspect the current repository.
2. Determine whether a project already exists or whether this needs to be initialized.
3. Identify the language/tooling that best fits the architecture.
4. Check installed dependencies and existing conventions.
5. Propose the architecture briefly.
6. Then implement it.

Do not stop at an architectural proposal.

Actually build the working MVP.

After implementation:

1. Run all tests.
2. Fix failures.
3. Run the test repository acceptance scenario.
4. Verify incremental indexing behavior.
5. Verify database persistence.
6. Verify MCP startup.
7. Verify MCP search.
8. Verify that unchanged chunks are not re-embedded.
9. Document anything that remains incomplete.

Do not replace real functionality with mocks merely to make tests pass.

Where an external local dependency such as Ollama is required, provide a clear setup check and graceful error message rather than silently falling back to a fake embedding implementation.

The final result should be a **usable local code intelligence infrastructure**, not merely a demo of vector search.
