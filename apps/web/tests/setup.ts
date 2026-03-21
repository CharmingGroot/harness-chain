import os from 'os';
import path from 'path';
import fs from 'fs';
import { beforeEach } from 'vitest';

// Unique data dir per worker (pid + random to avoid timestamp collisions)
const testDataDir = path.join(
  os.tmpdir(),
  `hc_test_${process.pid}_${Math.random().toString(36).slice(2)}`
);

process.env.DATA_DIR = testDataDir;
process.env.ANTHROPIC_API_KEY = 'test-key-placeholder';

fs.mkdirSync(testDataDir, { recursive: true });

// Reset data files to empty state before each test
beforeEach(() => {
  for (const file of ['harnesses.json', 'subagents.json', 'runs.json']) {
    fs.writeFileSync(path.join(testDataDir, file), '[]', 'utf-8');
  }
});
