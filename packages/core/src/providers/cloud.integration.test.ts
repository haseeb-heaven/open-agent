/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live integration tests against real cloud provider endpoints, one per
 * provider. Skipped in CI and for any provider whose API key is not set;
 * enable locally with `RUN_LIVE_PROVIDER_TESTS=1`. Keys are loaded from the
 * repo-root `.env` via packages/core/test-setup.ts (or export them yourself):
 *
 *   RUN_LIVE_PROVIDER_TESTS=1 npx vitest run src/providers/cloud.integration.test.ts --root packages/core
 *
 * Quota / empty-balance responses soft-skip (not product failures).
 */

import { describe, it, expect } from 'vitest';
import { OpenAICompatContentGenerator } from './openaiCompatGenerator.js';
import { getProvider, providerApiKey } from './providers.js';

const runLive =
  process.env['RUN_LIVE_PROVIDER_TESTS'] === '1' && !process.env['CI'];

/** One cheap/free model per cloud provider for a minimal live probe. */
const LIVE_MATRIX: Array<{ providerId: string; model: string }> = [
  { providerId: 'openai', model: 'openai/gpt-4o-mini' },
  { providerId: 'anthropic', model: 'anthropic/claude-haiku-4-5' },
  { providerId: 'gemini', model: 'gemini/gemini-2.5-flash' },
  { providerId: 'groq', model: 'groq/llama-3.1-8b-instant' },
  { providerId: 'deepseek', model: 'deepseek/deepseek-chat' },
  // NVIDIA's upstream ids carry their own org prefix ("nvidia/", "meta/"),
  // so registry ids double up: provider prefix + full upstream id.
  { providerId: 'nvidia', model: 'nvidia/nvidia/nemotron-3-super-120b-a12b' },
  {
    providerId: 'together',
    model: 'together/meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },
  {
    providerId: 'huggingface',
    model: 'huggingface/meta-llama/Llama-3.1-8B-Instruct',
  },
  { providerId: 'openrouter', model: 'openrouter/openai/gpt-oss-20b:free' },
  { providerId: 'cerebras', model: 'cerebras/gpt-oss-120b' },
  { providerId: 'z-ai', model: 'z-ai/glm-5' },
];

/**
 * Account / billing issues are not product regressions — soft-skip so live
 * matrix stays green when only some keys are funded.
 */
export function isSoftSkipProviderError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return (
    lower.includes('insufficient_quota') ||
    lower.includes('insufficient balance') ||
    lower.includes('credit balance is too low') ||
    lower.includes('no resource package') ||
    lower.includes('please recharge') ||
    lower.includes('exceeded your current quota') ||
    lower.includes('billing details') ||
    lower.includes('payment required') ||
    /\b402\b/.test(msg) ||
    // TPM / rate-limit soft skips for free tiers during live matrix runs
    (lower.includes('rate limit') && lower.includes('tokens')) ||
    lower.includes('rate_limit_exceeded') ||
    lower.includes('too many requests')
  );
}

for (const { providerId, model } of LIVE_MATRIX) {
  const provider = getProvider(providerId);
  const hasKey =
    provider !== undefined && providerApiKey(provider) !== undefined;

  describe.skipIf(!runLive || !hasKey)(`${providerId} (live endpoint)`, () => {
    it(`completes a tiny prompt on ${model}`, async () => {
      try {
        const generator = new OpenAICompatContentGenerator({
          modelId: model,
          provider: provider!,
        });
        const response = await generator.generateContent(
          {
            model,
            contents: [
              { role: 'user', parts: [{ text: 'Reply with the word: ok' }] },
            ],
            // Reasoning models (gpt-oss, gemini-2.5, nemotron-3) spend output
            // tokens on thinking before any visible text, so leave headroom.
            config: { maxOutputTokens: 1024, temperature: 0 },
          },
          'live-integration-test',
        );
        const text = response.candidates?.[0]?.content?.parts
          ?.map((p) => p.text ?? '')
          .join('');
        expect(typeof text).toBe('string');
        expect((text ?? '').length).toBeGreaterThan(0);
      } catch (err) {
        if (isSoftSkipProviderError(err)) {
          process.stderr.write(
            `[live soft-skip] ${providerId} complete: ${String(err).slice(0, 200)}\n`,
          );
          return; // treat as pass/soft-skip
        }
        throw err;
      }
    }, 60_000);

    it(`streams a tiny prompt on ${model}`, async () => {
      try {
        const generator = new OpenAICompatContentGenerator({
          modelId: model,
          provider: provider!,
        });
        const chunks: string[] = [];
        const stream = await generator.generateContentStream(
          {
            model,
            contents: [
              { role: 'user', parts: [{ text: 'Count from 1 to 3.' }] },
            ],
            config: { maxOutputTokens: 1024, temperature: 0 },
          },
          'live-integration-test',
        );
        for await (const chunk of stream) {
          const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) chunks.push(text);
        }
        expect(chunks.length).toBeGreaterThan(0);
      } catch (err) {
        if (isSoftSkipProviderError(err)) {
          process.stderr.write(
            `[live soft-skip] ${providerId} stream: ${String(err).slice(0, 200)}`,
          );
          return;
        }
        throw err;
      }
    }, 60_000);
  });
}
