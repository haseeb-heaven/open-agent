/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RoutingContext } from '../routingStrategy.js';
import type { Config } from '../../config/config.js';
import type { BaseLlmClient } from '../../core/baseLlmClient.js';
import type { LocalLiteRtLmClient } from '../../core/localLiteRtLmClient.js';
import {
  DEFAULT_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_MODEL,
} from '../../config/models.js';
import { createUserContent } from '@google/genai';

const mockSystemOne = vi.hoisted(() => vi.fn());
const mockTypeSafeClient = vi.hoisted(() =>
  vi.fn().mockImplementation(() => ({ systemOne: mockSystemOne })),
);

vi.mock('@typesafe-ai/sdk', () => ({
  TypeSafeClient: mockTypeSafeClient,
  choice: vi.fn((instructions: unknown, criteria: unknown) => ({
    type: 'choice',
    instructions,
    criteria,
  })),
}));

import { JevClassifierStrategy } from './jevClassifierStrategy.js';

describe('JevClassifierStrategy', () => {
  let strategy: JevClassifierStrategy;
  let mockContext: RoutingContext;
  let mockConfig: Config;
  let mockBaseLlmClient: BaseLlmClient;
  let mockLocalLiteRtLmClient: LocalLiteRtLmClient;

  const makeJevResponse = (
    complexity: string,
    confidence: number,
  ): unknown => ({
    model: 'jev-latest',
    answers: {
      complexity: {
        type: 'choice',
        choice: complexity,
        confidence,
        probabilities: { [complexity]: confidence },
      },
    },
    usage: { input_tokens: 10, output_tokens: 5 },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('JEV_API_KEY', 'test-jev-key');

    mockConfig = {
      getModel: () => DEFAULT_GEMINI_MODEL,
      getGemini31Launched: vi.fn().mockResolvedValue(false),
      getUseCustomToolModel: vi.fn().mockResolvedValue(false),
      getHasAccessToPreviewModel: vi.fn().mockReturnValue(true),
      hasGemini35FlashGAAccess: vi.fn().mockReturnValue(false),
      getModelAvailabilityService: vi.fn().mockReturnValue({
        snapshot: vi.fn().mockReturnValue({ available: true }),
      }),
    } as unknown as Config;

    strategy = new JevClassifierStrategy();
    mockContext = {
      history: [],
      request: 'simple task',
      signal: new AbortController().signal,
    };

    mockBaseLlmClient = {} as BaseLlmClient;
    mockLocalLiteRtLmClient = {} as LocalLiteRtLmClient;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should return null when JEV_API_KEY is not set', async () => {
    vi.stubEnv('JEV_API_KEY', '');

    const decision = await strategy.route(
      mockContext,
      mockConfig,
      mockBaseLlmClient,
      mockLocalLiteRtLmClient,
    );

    expect(decision).toBeNull();
    expect(mockSystemOne).not.toHaveBeenCalled();
  });

  it('should bypass when the request is a function response', async () => {
    mockContext = {
      ...mockContext,
      request: [
        {
          functionResponse: {
            name: 'read_file',
            response: { output: 'contents' },
          },
        },
      ],
    };

    const decision = await strategy.route(
      mockContext,
      mockConfig,
      mockBaseLlmClient,
      mockLocalLiteRtLmClient,
    );

    expect(decision).toBeNull();
    expect(mockSystemOne).not.toHaveBeenCalled();
  });

  it('should route to the flash tier for a simple task', async () => {
    mockSystemOne.mockResolvedValue(makeJevResponse('simple', 0.95));

    const decision = await strategy.route(
      mockContext,
      mockConfig,
      mockBaseLlmClient,
      mockLocalLiteRtLmClient,
    );

    expect(decision).not.toBeNull();
    expect(decision!.model).toBe(DEFAULT_GEMINI_FLASH_MODEL);
    expect(decision!.metadata.source).toBe('JevClassifier');
    expect(decision!.metadata.reasoning).toContain("'simple'");
  });

  it('should route to the flash tier for a standard task', async () => {
    mockSystemOne.mockResolvedValue(makeJevResponse('standard', 0.8));

    const decision = await strategy.route(
      mockContext,
      mockConfig,
      mockBaseLlmClient,
      mockLocalLiteRtLmClient,
    );

    expect(decision).not.toBeNull();
    expect(decision!.model).toBe(DEFAULT_GEMINI_FLASH_MODEL);
  });

  it('should route to the pro tier for a complex task', async () => {
    mockSystemOne.mockResolvedValue(makeJevResponse('complex', 0.9));

    const decision = await strategy.route(
      mockContext,
      mockConfig,
      mockBaseLlmClient,
      mockLocalLiteRtLmClient,
    );

    expect(decision).not.toBeNull();
    expect(decision!.model).toBe(DEFAULT_GEMINI_MODEL);
  });

  it('should route to the pro tier for an expert task', async () => {
    mockSystemOne.mockResolvedValue(makeJevResponse('expert', 0.99));

    const decision = await strategy.route(
      mockContext,
      mockConfig,
      mockBaseLlmClient,
      mockLocalLiteRtLmClient,
    );

    expect(decision).not.toBeNull();
    expect(decision!.model).toBe(DEFAULT_GEMINI_MODEL);
  });

  it('should decline when confidence is below the threshold', async () => {
    mockSystemOne.mockResolvedValue(makeJevResponse('complex', 0.3));

    const decision = await strategy.route(
      mockContext,
      mockConfig,
      mockBaseLlmClient,
      mockLocalLiteRtLmClient,
    );

    expect(decision).toBeNull();
  });

  it('should pass the API key and abort signal to the Jev client', async () => {
    mockSystemOne.mockResolvedValue(makeJevResponse('simple', 0.95));

    await strategy.route(
      mockContext,
      mockConfig,
      mockBaseLlmClient,
      mockLocalLiteRtLmClient,
    );

    expect(mockTypeSafeClient).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'test-jev-key' }),
    );
    expect(mockSystemOne).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.stringContaining('simple task'),
        questions: expect.objectContaining({ complexity: expect.anything() }),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('should decline when the selected model is unavailable', async () => {
    mockSystemOne.mockResolvedValue(makeJevResponse('simple', 0.95));
    vi.mocked(mockConfig.getModelAvailabilityService).mockReturnValue({
      snapshot: vi
        .fn()
        .mockReturnValue({ available: false, reason: 'quota exhausted' }),
    } as unknown as ReturnType<Config['getModelAvailabilityService']>);

    const decision = await strategy.route(
      mockContext,
      mockConfig,
      mockBaseLlmClient,
      mockLocalLiteRtLmClient,
    );

    expect(decision).toBeNull();
  });

  it('should return null when the Jev API call fails', async () => {
    mockSystemOne.mockRejectedValue(new Error('Jev API unavailable'));

    const decision = await strategy.route(
      mockContext,
      mockConfig,
      mockBaseLlmClient,
      mockLocalLiteRtLmClient,
    );

    expect(decision).toBeNull();
  });

  it('should include recent tool-free history in the evaluated state', async () => {
    mockSystemOne.mockResolvedValue(makeJevResponse('simple', 0.95));
    mockContext = {
      ...mockContext,
      history: [
        createUserContent('first question'),
        { role: 'model', parts: [{ text: 'first answer' }] },
        createUserContent([{ functionCall: { name: 'read_file', args: {} } }]),
      ],
    };

    await strategy.route(
      mockContext,
      mockConfig,
      mockBaseLlmClient,
      mockLocalLiteRtLmClient,
    );

    const state = mockSystemOne.mock.calls[0][0].state as string;
    expect(state).toContain('first question');
    expect(state).toContain('first answer');
    expect(state).toContain('simple task');
    expect(state).not.toContain('functionCall');
  });
});
