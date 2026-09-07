import { readFileSync } from 'node:fs';
import { recordDeniedScan } from '../usage/record.js';
import { shouldDenyTreeScan, TREE_SCAN_DENY_MESSAGE, type TreeScanInput } from './treeScanPolicy.js';

function readStdin(): TreeScanInput {
  try {
    const raw = readFileSync(0, 'utf8');
    return raw.trim() ? (JSON.parse(raw) as TreeScanInput) : {};
  } catch {
    return {};
  }
}

const input = readStdin();
if (shouldDenyTreeScan(input)) {
  recordDeniedScan(input);
  process.stdout.write(
    JSON.stringify({
      permission: 'deny',
      agent_message: TREE_SCAN_DENY_MESSAGE,
      user_message: 'Blocked workspace-wide scan; local code index should be queried first.'
    })
  );
} else {
  process.stdout.write(JSON.stringify({ permission: 'allow' }));
}
