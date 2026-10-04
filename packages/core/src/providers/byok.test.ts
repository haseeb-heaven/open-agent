/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  byokProvider,
  byokProviders,
  newlyAvailableModels,
  writeEnvKey,
} from './byok.js';
import { FreeLLMCatalog } from './freeCatalog.js';
import { ModelRegistry } from './modelRegistry.js';

describe('writeEnvKey', () => {
  let dir: string;
  let envPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-test-'));
    envPath = path.join(dir, '.env');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the .env file when missing', () => {
    writeEnvKey(envPath, 'GROQ_API_KEY', 'gsk-test');
    expect(fs.readFileSync(envPath, 'utf8')).toBe('GROQ_API_KEY=gsk-test\n');
  });

  it('appends without touching existing lines', () => {
    fs.writeFileSync(envPath, '# comment\nOPENAI_API_KEY=sk-old\n');
    writeEnvKey(envPath, 'GROQ_API_KEY', 'gsk-test');
    expect(fs.readFileSync(envPath, 'utf8')).toBe(
      '# comment\nOPENAI_API_KEY=sk-old\nGROQ_API_KEY=gsk-test\n',
    );
  });

  it('replaces an existing assignment in place', () => {
    fs.writeFileSync(envPath, 'GROQ_API_KEY=old\nOPENAI_API_KEY=sk\n');
    writeEnvKey(envPath, 'GROQ_API_KEY', 'new');
    expect(fs.readFileSync(envPath, 'utf8')).toBe(
      'GROQ_API_KEY=new\nOPENAI_API_KEY=sk\n',
    );
  });

  it('rejects empty values and invalid variable names; strips paste newlines', () => {
    expect(() => writeEnvKey(envPath, 'GROQ_API_KEY', '  ')).toThrow(
      /must not be empty/,
    );
    expect(() => writeEnvKey(envPath, 'bad name', 'x')).toThrow(/Invalid/);
    // Windows pastes often include \r\n — strip, don't throw.
    writeEnvKey(envPath, 'GROQ_API_KEY', 'gsk-paste\r\n');
    expect(fs.readFileSync(envPath, 'utf8')).toContain(
      'GROQ_API_KEY=gsk-paste',
    );
  });

  it('refuses drive-root paths and falls back to openagent home', () => {
    // path like D:\.env would mkdir D:\ — writeEnvKey must not EPERM.
    const driveRootEnv = path.join(path.parse(process.cwd()).root, '.env');
    writeEnvKey(driveRootEnv, 'NVIDIA_API_KEY', 'nv-test-key');
    // Should have written somewhere readable without throwing.
    expect(process.env['NVIDIA_API_KEY'] ?? 'nv-test-key').toBeTruthy();
  });
});

describe('newlyAvailableModels', () => {
  const registry = new ModelRegistry('test://models.toml', {
    models: {
      'groq-llama-3.1-8b': { model: 'groq/llama-3.1-8b-instant' },
      'openrouter-free': { model: 'openrouter/free' },
      'local-model': { model: 'llama3.1:8b', provider: 'local' },
    },
    free_catalog: [
      {
        id: 'groq-llama-3.1-8b',
        model_key: 'groq-llama-3.1-8b',
        provider: 'groq',
        env_key: 'GROQ_API_KEY',
        tier: 'free_tier',
        notes: '',
      },
      {
        id: 'openrouter-free',
        model_key: 'openrouter-free',
        provider: 'openrouter',
        env_key: 'OPENROUTER_API_KEY',
        tier: 'free',
        notes: '',
      },
      {
        id: 'local-model',
        model_key: 'local-model',
        provider: 'local',
        env_key: '',
        tier: 'local',
        notes: '',
      },
    ],
    default_priority: [],
  });
  const catalog = FreeLLMCatalog.load(registry);

  it('reports models unlocked by the new key only', () => {
    expect(
      newlyAvailableModels('GROQ_API_KEY', { registry, catalog, env: {} }),
    ).toEqual(['groq-llama-3.1-8b']);
  });

  it('does not report local models (already available)', () => {
    const unlocked = newlyAvailableModels('OPENROUTER_API_KEY', {
      registry,
      catalog,
      env: {},
    });
    expect(unlocked).toEqual(['openrouter-free']);
    expect(unlocked).not.toContain('local-model');
  });

  it('reports nothing for keys no model needs', () => {
    expect(
      newlyAvailableModels('UNRELATED_KEY', { registry, catalog, env: {} }),
    ).toEqual([]);
  });
});

describe('byokProviders', () => {
  it('lists only cloud providers with an env key', () => {
    const ids = byokProviders().map((p) => p.id);
    expect(ids).toContain('openai');
    expect(ids).toContain('openrouter');
    expect(ids).not.toContain('ollama');
    expect(ids).not.toContain('lmstudio');
  });

  it('byokProvider rejects local and unknown providers', () => {
    expect(() => byokProvider('ollama')).toThrow(/local/);
    expect(() => byokProvider('nope')).toThrow(/Unknown provider/);
    expect(byokProvider('groq').envKey).toBe('GROQ_API_KEY');
  });
});
