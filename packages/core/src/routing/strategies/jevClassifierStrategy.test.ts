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

  it('should decline an unsupported Jev complexity choice', async () => {
    mockSystemOne.mockResolvedValue(makeJevResponse('unsupported', 0.95));

    const decision = await strategy.route(
      mockContext,
      mockConfig,
      mockBaseLlmClient,
      mockLocalLiteRtLmClient,
    );

    expect(decision).toBeNull();
    expect(mockConfig.getGemini31Launched).not.toHaveBeenCalled();
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

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1])(
    'should decline when confidence is invalid: %s',
    async (confidence) => {
      mockSystemOne.mockResolvedValue(makeJevResponse('complex', confidence));

      const decision = await strategy.route(
        mockContext,
        mockConfig,
        mockBaseLlmClient,
        mockLocalLiteRtLmClient,
      );

      expect(decision).toBeNull();
      expect(mockConfig.getGemini31Launched).not.toHaveBeenCalled();
    },
  );

  it('should pass the API key and abort signal to the Jev client', async () => {
    mockSystemOne.mockResolvedValue(makeJevResponse('simple', 0.95));

    await strategy.route(
      mockContext,
      mockConfig,
      mockBaseLlmClient,
      mockLocalLiteRtLmClient,
    );

    expect(mockTypeSafeClient).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'test-jev-key',
        retry: { maxRetries: 0 },
      }),
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

  it('should send only current request text when history is present', async () => {
    mockSystemOne.mockResolvedValue(makeJevResponse('simple', 0.95));
    mockContext = {
      ...mockContext,
      history: [
        createUserContent('first question'),
        { role: 'model', parts: [{ text: 'first answer' }] },
        {
          role: 'model',
          parts: [{ functionCall: { name: 'read_file', args: {} } }],
        },
      ],
    };

    await strategy.route(
      mockContext,
      mockConfig,
      mockBaseLlmClient,
      mockLocalLiteRtLmClient,
    );

    const state = mockSystemOne.mock.calls[0][0].state as string;
    expect(state).not.toContain('first question');
    expect(state).not.toContain('first answer');
    expect(state).toContain('simple task');
    expect(state).not.toContain('functionCall');
  });

  it('should decline when the request contains non-text content', async () => {
    mockContext = {
      ...mockContext,
      request: [
        { text: 'Describe this image.' },
        { inlineData: { data: 'aW1hZ2U=', mimeType: 'image/png' } },
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

  it.each([
    ['non-string text', { text: 42 }],
    [
      'non-string thoughtSignature',
      { text: 'simple task', thoughtSignature: 42 },
    ],
  ])(
    'should decline when the request contains %s',
    async (_description, part) => {
      mockContext = {
        ...mockContext,
        request: [part] as unknown as typeof mockContext.request,
      };

      const decision = await strategy.route(
        mockContext,
        mockConfig,
        mockBaseLlmClient,
        mockLocalLiteRtLmClient,
      );

      expect(decision).toBeNull();
      expect(mockSystemOne).not.toHaveBeenCalled();
    },
  );

  it('should classify ordinary text parts with thoughtSignature metadata', async () => {
    mockSystemOne.mockResolvedValue(makeJevResponse('simple', 0.95));
    mockContext = {
      ...mockContext,
      request: [{ text: 'simple task', thoughtSignature: 'opaque-signature' }],
    };

    const decision = await strategy.route(
      mockContext,
      mockConfig,
      mockBaseLlmClient,
      mockLocalLiteRtLmClient,
    );

    expect(decision).not.toBeNull();
    expect(decision!.model).toBe(DEFAULT_GEMINI_FLASH_MODEL);
    expect(mockSystemOne).toHaveBeenCalledOnce();
  });

  it('should not send prior-turn text with thoughtSignature metadata', async () => {
    mockSystemOne.mockResolvedValue(makeJevResponse('simple', 0.95));
    mockContext = {
      ...mockContext,
      history: [
        {
          role: 'user',
          parts: [
            { text: 'earlier question', thoughtSignature: 'opaque-signature' },
          ],
        },
      ],
    };

    const decision = await strategy.route(
      mockContext,
      mockConfig,
      mockBaseLlmClient,
      mockLocalLiteRtLmClient,
    );

    expect(decision).not.toBeNull();
    expect(mockSystemOne).toHaveBeenCalledOnce();
    expect(mockSystemOne.mock.calls[0][0].state).not.toContain(
      'earlier question',
    );
  });

  it('should decline when the request contains thought-marked text', async () => {
    mockContext = {
      ...mockContext,
      request: [{ text: 'internal reasoning', thought: true }],
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

  it('should classify the current request without sending history media', async () => {
    mockSystemOne.mockResolvedValue(makeJevResponse('simple', 0.95));
    mockContext = {
      ...mockContext,
      history: [
        createUserContent([
          { text: 'prior turn' },
          {
            fileData: {
              fileUri: 'gs://test/document.pdf',
              mimeType: 'application/pdf',
            },
          },
        ]),
      ],
    };

    const decision = await strategy.route(
      mockContext,
      mockConfig,
      mockBaseLlmClient,
      mockLocalLiteRtLmClient,
    );

    expect(decision).not.toBeNull();
    expect(mockSystemOne).toHaveBeenCalledOnce();
    const state = mockSystemOne.mock.calls[0][0].state as string;
    expect(state).toContain('simple task');
    expect(state).not.toContain('prior turn');
    expect(state).not.toContain('document.pdf');
  });
});
