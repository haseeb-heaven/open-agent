/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live web-search smoke tests — run only when keys / network are present.
 * Keys load from repo-root `.env` via packages/core/test-setup.ts.
 *
 *   npx vitest run src/websearch/live.websearch.test.ts --root packages/core
 *
 * Skips backends whose env keys are missing (no hard-coded secrets).
 */

import { describe, expect, it } from 'vitest';
import { braveBackend } from './backends/brave.js';
import { tavilyBackend } from './backends/tavily.js';
import { serperBackend } from './backends/serper.js';
import { exaBackend } from './backends/exa.js';
import { duckduckgoBackend } from './backends/duckduckgo.js';
import { executeWebSearchHttp, planWebSearchRoute } from './router.js';
import { hasGeminiSearchKey } from './backends/gemini.js';

const QUERY = 'TypeScript official handbook';

function has(envKey: string | null): boolean {
  if (!envKey) return true;
  return Boolean(process.env[envKey]?.trim());
}

describe('live web search (env keys)', () => {
  it('plans a route for current env', () => {
    const plan = planWebSearchRoute({
      modelId: process.env['TEST_MODEL_ID'] ?? 'openrouter-free',
      env: process.env,
    });
    expect(plan.providerId).toBeTruthy();
    expect(plan.ranked.length).toBeGreaterThan(3);
  });

  it('duckduckgo (always)', async () => {
    const r = await duckduckgoBackend.search(QUERY);
    expect(r.hits.length + r.summary.length).toBeGreaterThan(0);
  }, 30000);

  it.skipIf(!has('BRAVE_API_KEY'))(
    'brave live',
    async () => {
      const r = await braveBackend.search(QUERY, { env: process.env });
      expect(r.hits.length).toBeGreaterThan(0);
      expect(r.hits[0].url).toMatch(/^https?:\/\//);
    },
    30000,
  );

  it.skipIf(!has('TAVILY_API_KEY'))(
    'tavily live',
    async () => {
      const r = await tavilyBackend.search(QUERY, { env: process.env });
      expect(r.summary.length).toBeGreaterThan(10);
    },
    30000,
  );

  it.skipIf(!has('SERPER_API_KEY'))(
    'serper live',
    async () => {
      const r = await serperBackend.search(QUERY, { env: process.env });
      expect(r.hits.length).toBeGreaterThan(0);
    },
    30000,
  );

  it('exa live (keyless MCP)', async () => {
    const r = await exaBackend.search(QUERY, { env: process.env });
    expect(r.hits.length + r.summary.length).toBeGreaterThan(0);
  }, 30000);

  it.skipIf(!hasGeminiSearchKey())(
    'gemini key present (grounding exercised via tool unit tests)',
    () => {
      expect(hasGeminiSearchKey()).toBe(true);
    },
  );

  it('executeWebSearchHttp chain with current env', async () => {
    const r = await executeWebSearchHttp({
      query: QUERY,
      env: process.env,
      modelId: 'openrouter-free',
    });
    expect(r.provider).toBeTruthy();
    expect(r.summary.length).toBeGreaterThan(10);
  }, 45000);
});
