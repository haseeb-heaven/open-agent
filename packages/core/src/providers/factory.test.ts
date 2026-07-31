/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { createMultiProviderGenerator } from './factory.js';
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
