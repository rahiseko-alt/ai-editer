#!/usr/bin/env node
// .claude/hooks/rules-coverage-gate.mjs
// monorepo 統合後 (commit c0a456f): vibe-governance は vibe-base に吸収済。

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const TARGET_REL = 'scripts/check-rules-coverage.sh';

function resolveRepoRoot() {
  const env = process.env.VIBE_GOVERNANCE_ROOT;
  if (env && fs.existsSync(path.join(env, TARGET_REL))) return path.resolve(env);
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const cand = path.resolve(dir, '..', '..');
  if (fs.existsSync(path.join(cand, TARGET_REL))) return cand;
  return null;
}

const stdin = fs.readFileSync(0);
const root = resolveRepoRoot();
if (!root) {
  process.stderr.write('rules-coverage-gate: scripts/check-rules-coverage.sh not found. skip.\n');
  process.exit(0);
}

const r = spawnSync('bash', [path.join(root, TARGET_REL)], {
  input: stdin,
  stdio: ['pipe', 'inherit', 'inherit'],
});
process.exit(r.status ?? 0);
