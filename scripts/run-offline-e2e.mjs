/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { Console } from 'node:console';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const logger = new Console({ stdout: process.stdout, stderr: process.stderr });
const manifestPath = resolve(
  root,
  'integration-tests/offline-e2e-manifest.json',
);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const cases = manifest.cases;
const key = ({ file, name }) => `${file}::${name}`;
const keys = cases.map(key);
if (new Set(keys).size !== keys.length) {
  logger.error(
    'Offline E2E manifest contains duplicate file::test identities.',
  );
  process.exit(1);
}

const files = [...new Set(cases.map(({ file }) => file))];
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const groups = files.map((file) => {
  const fileCases = cases.filter((testCase) => testCase.file === file);
  const filtered = fileCases.length > 0 && fileCases.every(({ testTitle }) => typeof testTitle === 'string' && testTitle.length > 0);
  return {
    file,
    filtered,
    pattern: filtered
      ? `^(?:${[...new Set(fileCases.map(({ name }) => escapeRegex(name)))].join('|')})$`
      : null,
  };
});
const tempDir = mkdtempSync(resolve(tmpdir(), 'open-agent-offline-e2e-'));
const networkAttemptsPath = resolve(tempDir, 'blocked-network-attempts.jsonl');
writeFileSync(networkAttemptsPath, '');
const env = Object.fromEntries(
  ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE']
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]]),
);
env.NODE_OPTIONS = `--require=${resolve(root, 'scripts/offline-network-guard.cjs')}`;
env.GEMINI_TEST_TYPE = 'integration';
env.GEMINI_SANDBOX = 'false';
env.GEMINI_OFFLINE_NETWORK_ATTEMPTS = networkAttemptsPath;

try {
  const vitest = resolve(root, 'node_modules/.bin/vitest');
  const resultSets = [];
  let runFailed = false;
  for (const [index, group] of groups.entries()) {
    const resultsPath = resolve(tempDir, `vitest-results-${index}.json`);
    const args = [
      'run',
      '--root',
      './integration-tests',
      '--config',
      './vitest.offline.config.ts',
      '--retry=0',
      '--fileParallelism=false',
      '--maxWorkers=1',
      '--reporter=json',
      `--outputFile=${resultsPath}`,
    ];
    if (group.pattern) args.push('--testNamePattern', group.pattern);
    args.push(group.file);
    const run = spawnSync(vitest, args, {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: 'inherit',
    });
    if (run.error || run.status !== 0) runFailed = true;

    try {
      resultSets.push({
        results: JSON.parse(readFileSync(resultsPath, 'utf8')),
        filtered: group.filtered,
      });
    } catch (error) {
      logger.error(`Could not parse Vitest JSON results for ${group.file}: ${error.message}`);
      process.exitCode = 1;
    }
  }

  let verifiedPassCount = 0;
  if (resultSets.length) {
    const observed = new Map();
    const passed = new Set();
    const failures = [];
    const expectedKeys = new Set(keys);
    for (const { results, filtered } of resultSets) for (const suite of results.testResults ?? []) {
      const file = suite.name?.replaceAll('\\', '/').split('/').at(-1);
      for (const test of suite.assertionResults ?? []) {
        const fullName =
          test.fullName ||
          [...(test.ancestorTitles ?? []), test.title].join(' ');
        const identity = key({ file, name: fullName });
        observed.set(identity, (observed.get(identity) ?? 0) + 1);
        if (test.status === 'passed') passed.add(identity);
        if (expectedKeys.has(identity) && test.status !== 'passed')
          failures.push(`${identity}: ${test.status}`);
        if (!expectedKeys.has(identity) && (!filtered || test.status !== 'skipped'))
          failures.push(`${identity}: unlisted test has status ${test.status}`);
      }
    }
    for (const expected of keys) {
      const count = observed.get(expected) ?? 0;
      if (count !== 1)
        failures.push(
          `${expected}: appeared ${count} times (expected exactly once)`,
        );
    }
    verifiedPassCount = keys.filter(
      (expected) => observed.get(expected) === 1 && passed.has(expected),
    ).length;
    const total = [...observed.values()].reduce((sum, count) => sum + count, 0);
    logger.log(
      `Offline E2E: ${keys.length} manifest cases; ${total} observed; ${verifiedPassCount} verified passes; acceptance ${verifiedPassCount}/${manifest.acceptanceMinimum}.`,
    );
    if (failures.length) {
      logger.error(
        `Offline E2E result validation failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`,
      );
      process.exitCode = 1;
    }
  }
  if (verifiedPassCount < manifest.acceptanceMinimum) {
    logger.error(
      `Acceptance gate failed: ${verifiedPassCount}/${manifest.acceptanceMinimum} meaningful offline E2E cases.`,
    );
    process.exitCode = 1;
  }
  if (runFailed) process.exitCode = 1;
  const blockedAttempts = readFileSync(networkAttemptsPath, 'utf8')
    .split('\n')
    .filter(Boolean);
  if (blockedAttempts.length) {
    logger.error(
      `Offline E2E network guard recorded ${blockedAttempts.length} blocked non-loopback attempt(s): ${blockedAttempts.join(', ')}`,
    );
    process.exitCode = 1;
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
