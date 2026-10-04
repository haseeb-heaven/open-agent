/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const MIN_MAJOR = 22;

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('Node.js version baseline consistency', () => {
  it('.nvmrc pins the minimum supported major version', () => {
    const nvmrc = readFileSync(join(ROOT, '.nvmrc'), 'utf8').trim();
    expect(nvmrc).toBe(String(MIN_MAJOR));
  });

  it('root and workspace package.json engines.node require the minimum major', () => {
    const packageJsonPaths = [
      'package.json',
      'packages/a2a-server/package.json',
      'packages/cli/package.json',
      'packages/core/package.json',
      'packages/devtools/package.json',
      'packages/sdk/package.json',
      'packages/test-utils/package.json',
    ];

    for (const relativePath of packageJsonPaths) {
      const pkg = readJson(join(ROOT, relativePath));
      expect(pkg.engines?.node, `${relativePath} engines.node`).toBeDefined();
      const match = pkg.engines.node.match(/(\d+)/);
      expect(match, `${relativePath} engines.node format`).not.toBeNull();
      expect(Number(match![1]), `${relativePath} engines.node major`).toBe(
        MIN_MAJOR,
      );
    }
  });

  it('no workflow pins a Node.js major version older than the minimum', () => {
    const workflowsDir = join(ROOT, '.github', 'workflows');
    const workflowFiles = readdirSync(workflowsDir).filter((f) =>
      f.endsWith('.yml'),
    );

    const offenders: string[] = [];
    for (const file of workflowFiles) {
      const content = readFileSync(join(workflowsDir, file), 'utf8');
      const versionMatches = content.matchAll(
        /node-version:\s*['"]?(\d+)(?:\.x)?['"]?/g,
      );
      for (const m of versionMatches) {
        const major = Number(m[1]);
        if (major < MIN_MAJOR) {
          offenders.push(`${file}: node-version ${m[1]}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('release workflows reference the real root .nvmrc, not a nonexistent path', () => {
    const workflowsDir = join(ROOT, '.github', 'workflows');
    const releaseWorkflows = ['release-manual.yml', 'release-nightly.yml'];

    for (const file of releaseWorkflows) {
      const content = readFileSync(join(workflowsDir, file), 'utf8');
      expect(content).not.toContain('./release/.nvmrc');
      expect(content).toContain("node-version-file: '.nvmrc'");
    }
  });
});
