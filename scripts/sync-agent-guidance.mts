// Regenerates the checked-in agent guidance files from the strings the installers write.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_CODE_INTEL_SKILL } from '../src/cursor/skill.js';
import { LOCAL_CODE_INTEL_USER_RULE } from '../src/cursor/userRule.js';
import { LOCAL_CODE_INTEL_INSTRUCTIONS } from '../src/vscode/instructions.js';

const root = join(import.meta.dirname, '..');
const files: Record<string, string> = {
  'examples/cursor/use-local-code-intel.mdc': LOCAL_CODE_INTEL_USER_RULE,
  '.cursor/rules/use-local-code-intel.mdc': LOCAL_CODE_INTEL_USER_RULE,
  'examples/cursor/local-code-intel.SKILL.md': LOCAL_CODE_INTEL_SKILL,
  'examples/vscode/use-local-code-intel.instructions.md': LOCAL_CODE_INTEL_INSTRUCTIONS
};

for (const [path, contents] of Object.entries(files)) {
  writeFileSync(join(root, path), contents);
  console.log(`wrote ${path}`);
}
