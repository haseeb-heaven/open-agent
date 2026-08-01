/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import {
  createMultiProviderGenerator,
  isMultiProviderModel,
} from './factory.js';
import { ModelRegistry } from './modelRegistry.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const registryPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../configs/models.toml',
);

const TEST_ENV: NodeJS.ProcessEnv = {
  OPENAI_API_KEY: 'test',
  ANTHROPIC_API_KEY: 'test',
  GEMINI_API_KEY: 'test',
  GROQ_API_KEY: 'test',
  DEEPSEEK_API_KEY: 'test',
  NVIDIA_API_KEY: 'test',
  TOGETHER_API_KEY: 'test',
  HUGGINGFACE_API_KEY: 'test',
  OPENROUTER_API_KEY: 'test',
  CEREBRAS_API_KEY: 'test',
  Z_AI_API_KEY: 'test',
  BROWSER_USE_API_KEY: 'test',
};

describe('provider factory performance', () => {
  it('resolves every registered non-Gemini model within the fast setup budget', () => {
    const registry = ModelRegistry.load(registryPath);
    const models = registry.listModelNames().filter((name) => {
      const model = registry.getModel(name);
      return (
        model?.provider !== 'gemini' &&
        model?.provider !== 'local' &&
        !model?.model.startsWith('gemini/')
      );
    });

    const startedAt = performance.now();
    let routedModels = 0;
    for (const model of models) {
      if (createMultiProviderGenerator(model, TEST_ENV, registry)) {
        routedModels++;
      }
    }
    const elapsedMs = performance.now() - startedAt;

    // This is local setup only; no provider network request is made here.
    expect(routedModels).toBeGreaterThan(0);
    expect(
      elapsedMs,
      `model setup took ${elapsedMs.toFixed(1)} ms`,
    ).toBeLessThan(5000);
  });
});

describe('local provider sentinel routing', () => {
  const registry = ModelRegistry.load(registryPath);

  it('treats the "local" provider tag as the Ollama route', () => {
    const cfg = registry.getModel('local-model');
    expect(cfg?.provider).toBe('local');

    // Regression: the registry default model ("local-model") carries the
    // sentinel provider tag "local". The factory must map it to Ollama, or
    // startup auth on a zero-key install throws "No provider route found
    // for model \"local-model\"" (resolve.ts and picker.ts already map it).
    expect(isMultiProviderModel('local-model', registry)).toBe(true);
    const generator = createMultiProviderGenerator('local-model', {}, registry);
    expect(generator).toBeDefined();
    expect(generator!.apiBase).toMatch(/localhost:11434/);
  });

  it('routes a bare ollama/... id without any key set', () => {
    const generator = createMultiProviderGenerator(
      'ollama/llama3.1:8b',
      {},
      registry,
    );
    expect(generator).toBeDefined();
  });
});
