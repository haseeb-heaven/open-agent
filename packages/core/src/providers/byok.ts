/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BYOK (bring your own key) support: writes provider API keys to a
 * `.env` file and reports which models become newly available.
 *
 * Default path is `~/.openagent/.env` (never project cwd / drive root).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PROVIDERS,
  getProvider,
  type ProviderDefinition,
} from './providers.js';
import { FreeLLMCatalog } from './freeCatalog.js';
import { ModelRegistry } from './modelRegistry.js';
import {
  ensureOpenAgentHomeDir,
  getDefaultEnvFilePath,
} from '../utils/paths.js';

/** Cloud providers that accept a BYOK key, in walkthrough order. */
export function byokProviders(): ProviderDefinition[] {
  return PROVIDERS.filter((p) => !p.local && p.envKey !== null);
}

/**
 * True when `dir` is a filesystem root (e.g. `D:\` or `/`) — never mkdir these.
 */
function isFilesystemRoot(dir: string): boolean {
  const resolved = path.resolve(dir);
  const root = path.parse(resolved).root;
  return path.resolve(resolved) === path.resolve(root);
}

/**
 * Writes (or replaces) `KEY=value` in the `.env` file at `envPath`,
 * preserving every other line. Creates the file when missing. Returns
 * the env var name that was written.
 *
 * When `envPath` is omitted, writes to `~/.openagent/.env`.
 * Refuses paths whose parent is a drive root (fixes EPERM mkdir 'D:\').
 */
export function writeEnvKey(
  envPath: string | undefined,
  envKey: string,
  value: string,
): string;
export function writeEnvKey(envKey: string, value: string): string;
export function writeEnvKey(
  envPathOrKey: string | undefined,
  envKeyOrValue: string,
  valueMaybe?: string,
): string {
  // Support writeEnvKey(path, key, value) and writeEnvKey(key, value).
  let envPath: string;
  let envKey: string;
  let value: string;
  if (valueMaybe === undefined) {
    envPath = getDefaultEnvFilePath();
    envKey = String(envPathOrKey ?? '');
    value = envKeyOrValue;
  } else {
    envPath = envPathOrKey?.trim() ? envPathOrKey : getDefaultEnvFilePath();
    envKey = envKeyOrValue;
    value = valueMaybe;
  }

  const key = envKey.trim();
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    throw new Error(`Invalid environment variable name: ${envKey}`);
  }
  // Strip all whitespace so Windows pastes never carry \r/\n.
  const cleanValue = value.replace(/\s+/g, '').trim();
  if (!cleanValue) {
    throw new Error('API key value must not be empty');
  }

  let target = path.resolve(envPath);
  let parent = path.dirname(target);

  // Never try to mkdir drive roots (EPERM on Windows for D:\).
  if (isFilesystemRoot(parent)) {
    target = path.resolve(getDefaultEnvFilePath());
    parent = path.dirname(target);
  }

  // Ensure parent is under a real directory we own (openagent home or existing).
  if (!fs.existsSync(parent)) {
    if (isFilesystemRoot(parent)) {
      throw new Error(
        `Cannot write env file next to drive root (${parent}). Using OpenAgent home instead.`,
      );
    }
    // Prefer creating only ~/.openagent, not arbitrary deep trees from bad cwd.
    if (
      parent === path.resolve(ensureOpenAgentHomeDir()) ||
      parent.startsWith(path.resolve(ensureOpenAgentHomeDir()) + path.sep)
    ) {
      fs.mkdirSync(parent, { recursive: true });
    } else {
      // Fall back to the canonical OpenAgent env file.
      target = path.resolve(getDefaultEnvFilePath());
      parent = path.dirname(target);
      fs.mkdirSync(parent, { recursive: true });
    }
  }

  let lines: string[] = [];
  try {
    lines = fs.readFileSync(target, 'utf8').split(/\r?\n/);
  } catch {
    // Missing file: start fresh.
  }

  const assignment = `${key}=${cleanValue}`;
  let replaced = false;
  const next = lines.map((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match && match[1] === key && !replaced) {
      replaced = true;
      return assignment;
    }
    return line;
  });
  while (next.length > 0 && next[next.length - 1] === '') next.pop();
  if (!replaced) {
    next.push(assignment);
  }

  fs.writeFileSync(target, next.join('\n') + '\n', { mode: 0o600 });
  return key;
}

/**
 * Registry model keys that become available with `envKey` set, i.e.
 * models unusable before but usable after. Availability is derived from
 * the provider tag / env requirements of the free catalog and the
 * provider definitions.
 */
export function newlyAvailableModels(
  envKey: string,
  options: {
    registry?: ModelRegistry;
    catalog?: FreeLLMCatalog;
    env?: NodeJS.ProcessEnv;
  } = {},
): string[] {
  const registry = options.registry ?? ModelRegistry.load();
  const catalog = options.catalog ?? FreeLLMCatalog.load(registry);
  const baseEnv = options.env ?? process.env;

  const before: NodeJS.ProcessEnv = { ...baseEnv };
  delete before[envKey];
  const after: NodeJS.ProcessEnv = { ...baseEnv, [envKey]: 'set' };

  const availableBefore = new Set(
    catalog.available(before, registry).map((e) => e.config),
  );
  const models = catalog
    .available(after, registry)
    .map((e) => e.config)
    .filter((config) => !availableBefore.has(config));
  return [...new Set(models)];
}

/** Resolves a provider by id for the BYOK flow, throwing on unknowns. */
export function byokProvider(providerId: string): ProviderDefinition {
  const provider = getProvider(providerId);
  if (!provider) {
    const known = byokProviders()
      .map((p) => p.id)
      .join(', ');
    throw new Error(`Unknown provider "${providerId}". Known: ${known}`);
  }
  if (provider.local || !provider.envKey) {
    throw new Error(`Provider "${provider.id}" is local and needs no API key.`);
  }
  return provider;
}
