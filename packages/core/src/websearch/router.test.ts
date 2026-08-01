/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  planWebSearchRoute,
  recommendedWebSearchProviderId,
  rankWebSearchProviders,
  executeWebSearchHttp,
} from './router.js';
import { inferModelFamily } from './modelFamily.js';

describe('inferModelFamily', () => {
  it('detects gemini / local / open_source families', () => {
    expect(inferModelFamily('gemini-2.5-flash')).toBe('gemini');
    expect(inferModelFamily('ollama/llama3.1:8b')).toBe('local');
    expect(inferModelFamily('openrouter-free')).toBe('open_source');
    expect(inferModelFamily('groq-llama-3.1-8b')).toBe('open_source');
  });
});

describe('recommendedWebSearchProviderId', () => {
  it('recommends gemini for Gemini models', () => {
    expect(recommendedWebSearchProviderId('gemini')).toBe('gemini');
  });
  it('recommends exa for open_source', () => {
    expect(recommendedWebSearchProviderId('open_source')).toBe('exa');
  });
  it('recommends duckduckgo for local', () => {
    expect(recommendedWebSearchProviderId('local')).toBe('duckduckgo');
  });
});

describe('planWebSearchRoute', () => {
  it('uses exa (keyless) when no keys', () => {
    const plan = planWebSearchRoute({
      modelId: 'openrouter-free',
      env: {},
    });
    expect(plan.providerId).toBe('exa');
    expect(plan.ranked.some((r) => r.meta.id === 'exa')).toBe(true);
  });

  it('prefers brave when key set for open-source model and exa unavailable', () => {
    const plan = planWebSearchRoute({
      modelId: 'groq-llama-3.1-8b',
      env: { BRAVE_API_KEY: 'x', EXA_API_KEY: 'e' },
      preferredProviderId: 'brave',
    });
    expect(plan.providerId).toBe('brave');
    expect(plan.reason.toLowerCase()).toMatch(/recommended|available|brave/);
  });

  it('prefers gemini when gemini model + GEMINI_API_KEY', () => {
    const plan = planWebSearchRoute({
      modelId: 'gemini-2.5-flash',
      env: { GEMINI_API_KEY: 'g' },
    });
    expect(plan.providerId).toBe('gemini');
  });

  it('honors WEB_SEARCH_PROVIDER / preferred when available', () => {
    const plan = planWebSearchRoute({
      modelId: 'gemini-2.5-flash',
      env: { TAVILY_API_KEY: 't', GEMINI_API_KEY: 'g' },
      preferredProviderId: 'tavily',
    });
    expect(plan.providerId).toBe('tavily');
  });

  it('marks recommended row for current model', () => {
    const ranked = rankWebSearchProviders({
      modelId: 'gemini-2.5-flash',
      env: {},
    });
    const gem = ranked.find((r) => r.meta.id === 'gemini');
    expect(gem?.recommended).toBe(true);
  });
});

describe('executeWebSearchHttp', () => {
  it('uses exa with empty env (keyless), duckduckgo as ultimate fallback', async () => {
    const result = await executeWebSearchHttp({
      query: 'TypeScript handbook',
      env: {},
      modelId: 'openrouter-free',
    });
    expect(result.provider).toMatch(/exa|duckduckgo/);
    expect(result.summary.length).toBeGreaterThan(10);
  }, 30000);
});
