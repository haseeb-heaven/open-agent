/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GenerateContentParameters } from '@google/genai';
import { ModelRoutingContentGenerator } from './routingGenerator.js';
import type { ContentGenerator } from '../core/contentGenerator.js';
import { LlmRole } from '../telemetry/llmRole.js';

const createMultiProviderGenerator = vi.hoisted(() => vi.fn());
const isMultiProviderModel = vi.hoisted(() => vi.fn());
vi.mock('./factory.js', () => ({
  createMultiProviderGenerator,
  isMultiProviderModel,
}));

function mockGenerator(): ContentGenerator {
  return {
    generateContent: vi.fn().mockResolvedValue({ candidates: [] }),
    generateContentStream: vi.fn(),
    countTokens: vi.fn().mockResolvedValue({ totalTokens: 1 }),
    embedContent: vi.fn(),
  } as unknown as ContentGenerator;
}

const REQUEST = (model: string): GenerateContentParameters => ({
  model,
  contents: 'hello',
});

describe('ModelRoutingContentGenerator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates Google models to the base generator', async () => {
    isMultiProviderModel.mockReturnValue(false);
    const base = mockGenerator();
    const router = new ModelRoutingContentGenerator(base, {
      getModel: () => 'gemini-2.5-flash',
    });
    await router.generateContent(
      REQUEST('gemini-2.5-flash'),
      'id',
      LlmRole.MAIN,
    );
    expect(base.generateContent).toHaveBeenCalled();
    expect(createMultiProviderGenerator).not.toHaveBeenCalled();
  });

  it('routes multi-provider models away from the base mid-session', async () => {
    // Simulates /model switching from a Gemini-auth session to Groq.
    isMultiProviderModel.mockImplementation((m: string) =>
      m.startsWith('groq'),
    );
    const base = mockGenerator();
    const groq = mockGenerator();
    createMultiProviderGenerator.mockReturnValue(groq);
    let sessionModel = 'groq-llama-3.3-70b';
    const router = new ModelRoutingContentGenerator(base, {
      getModel: () => sessionModel,
    });

    await router.generateContent(
      REQUEST('groq-llama-3.3-70b'),
      'id',
      LlmRole.MAIN,
    );
    expect(groq.generateContent).toHaveBeenCalled();
    expect(base.generateContent).not.toHaveBeenCalled();

    // Cached on the second call.
    await router.generateContent(
      REQUEST('groq-llama-3.3-70b'),
      'id',
      LlmRole.MAIN,
    );
    expect(createMultiProviderGenerator).toHaveBeenCalledTimes(1);

    // Stale request model must NOT override an active multi-provider session
    // (this was the "still gemini after /model openrouter" bug).
    await router.generateContent(
      REQUEST('gemini-2.5-flash'),
      'id',
      LlmRole.MAIN,
    );
    expect(base.generateContent).not.toHaveBeenCalled();
    expect(groq.generateContent).toHaveBeenCalledTimes(3);

    // Switching the session model back to Google returns to the base generator.
    sessionModel = 'gemini-2.5-flash';
    await router.generateContent(
      REQUEST('gemini-2.5-flash'),
      'id',
      LlmRole.MAIN,
    );
    expect(base.generateContent).toHaveBeenCalledTimes(1);
  });

  it('falls back to the session model when the request has none', async () => {
    isMultiProviderModel.mockImplementation((m: string) =>
      m.startsWith('cerebras'),
    );
    const base = mockGenerator();
    const cerebras = mockGenerator();
    createMultiProviderGenerator.mockReturnValue(cerebras);
    const router = new ModelRoutingContentGenerator(base, {
      getModel: () => 'cerebras-gpt-oss-120b',
    });
    await router.countTokens({ model: '', contents: 'x' });
    expect(cerebras.countTokens).toHaveBeenCalled();
  });
});
