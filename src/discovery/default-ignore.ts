/**
 * Default exclusions, expressed as gitignore-syntax patterns (consumed by the
 * `ignore` package). Bare names (no slash) match at any depth, matching a
 * directory excludes everything beneath it — standard gitignore semantics.
 */
export const DEFAULT_IGNORE_PATTERNS: string[] = [
  // VCS / tooling directories
  '.git/',
  '.svn/',
  '.hg/',
  // dependency / build output directories
  'node_modules/',
  'dist/',
  'build/',
  'out/',
  'coverage/',
  '.next/',
  '.nuxt/',
  '.turbo/',
  'target/',
  'vendor/',
  '.cache/',
  'tmp/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.pytest_cache/',
  '.mypy_cache/',
  '.tox/',
  '.gradle/',
  '.idea/',
  '.vscode-test/',
  // mobile build tooling (React Native / Expo / iOS / Android) — compiled dependency
  // artifacts and IDE project bundles, not source code
  'Pods/',
  '.expo/',
  '.expo-shared/',
  'Carthage/',
  'DerivedData/',
  '*.xcworkspace/',
  '*.xcodeproj/',
  '*.xcframework/',
  '*.dSYM/',
  // generated / lock files
  '*.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'npm-shrinkwrap.json',
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.pyc',
  '*.pyo',
  '*.class',
  '*.o',
  '*.obj',
  // archives
  '*.zip',
  '*.tar',
  '*.tar.gz',
  '*.tgz',
  '*.rar',
  '*.7z',
  // images / media / fonts (binary, no useful text content)
  '*.png',
  '*.jpg',
  '*.jpeg',
  '*.gif',
  '*.webp',
  '*.ico',
  '*.bmp',
  '*.tiff',
  '*.mp4',
  '*.mov',
  '*.avi',
  '*.mkv',
  '*.webm',
  '*.mp3',
  '*.wav',
  '*.flac',
  '*.ogg',
  '*.pdf',
  '*.woff',
  '*.woff2',
  '*.ttf',
  '*.eot',
  // compiled binaries
  '*.exe',
  '*.dll',
  '*.so',
  '*.dylib',
  '*.jar',
  '*.wasm',
  '*.a',
  '*.framework/',
  '*.apk',
  '*.aab',
  '*.ipa'
];

/**
 * Files that may contain secrets, excluded by default regardless of
 * `.gitignore` (spec section 7). NOT excluded: package.json, tsconfig.json,
 * docker-compose.yml, Dockerfile, pyproject.toml, Cargo.toml, go.mod, etc. —
 * those carry architectural context and should still be indexed.
 */
export const SECRET_FILE_PATTERNS: string[] = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'credentials.*',
  'secrets.*',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  '*.keystore',
  '*.jks'
];
