/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';
import {
  WebSearchTool,
  WEB_SEARCH_CHAIN_HINT,
  type WebSearchToolParams,
} from './web-search.js';
import type { Config } from '../config/config.js';
import { GeminiClient } from '../core/client.js';
import { createMockMessageBus } from '../test-utils/mock-message-bus.js';

// Mock GeminiClient and Config constructor
vi.mock('../core/client.js');
vi.mock('../config/config.js');

describe('WebSearchTool', () => {
  const abortSignal = new AbortController().signal;
  let mockGeminiClient: GeminiClient;
  let tool: WebSearchTool;

  beforeEach(() => {
    // Force the Gemini grounding path regardless of real provider keys that
    // may be present in the developer's local .env (loaded by test-setup.ts
    // for live websearch probes) — otherwise planWebSearchRoute prefers a
    // real HTTP backend (Exa/Brave/Tavily/…) and these tests hit the network.
    vi.stubEnv('BRAVE_API_KEY', '');
    vi.stubEnv('TAVILY_API_KEY', '');
    vi.stubEnv('SERPER_API_KEY', '');
    vi.stubEnv('EXA_API_KEY', '');
    // Exa is keyless (freeNoKey) now, so also force Gemini explicitly and
    // give the Gemini client a key so the plan selects the Gemini path.
    vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key');
    vi.stubEnv('WEB_SEARCH_PROVIDER', 'gemini');

    // Stub fetch so the independent-search fallback path (Exa/DuckDuckGo)
    // never hits the real network in unit tests.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        text: async () =>
          'data: {"result":{"content":[{"type":"text","text":"Title: Mock Result\\nURL: https://example.com/mock"}]}}',
        json: async () => ({ results: [] }),
      })),
    );

    const mockConfigInstance = {
      getGeminiClient: () => mockGeminiClient,
      get geminiClient() {
        return mockGeminiClient;
      },
      getProxy: () => undefined,
      generationConfigService: {
        getResolvedConfig: vi.fn().mockImplementation(({ model }) => ({
          model,
          sdkConfig: {},
        })),
      },
    } as unknown as Config;
    (
      mockConfigInstance as unknown as { config: Config; promptId: string }
    ).config = mockConfigInstance;
    (
      mockConfigInstance as unknown as { config: Config; promptId: string }
    ).promptId = 'test-prompt-id';
    mockGeminiClient = new GeminiClient(mockConfigInstance);
    tool = new WebSearchTool(mockConfigInstance, createMockMessageBus());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  describe('build', () => {
    it('should return an invocation for a valid query', () => {
      const params: WebSearchToolParams = { query: 'test query' };
      const invocation = tool.build(params);
      expect(invocation).toBeDefined();
      expect(invocation.params).toEqual(params);
    });

    it('should throw an error for an empty query', () => {
      const params: WebSearchToolParams = { query: '' };
      expect(() => tool.build(params)).toThrow(
        "The 'query' parameter cannot be empty.",
      );
    });

    it('should throw an error for a query with only whitespace', () => {
      const params: WebSearchToolParams = { query: '   ' };
      expect(() => tool.build(params)).toThrow(
        "The 'query' parameter cannot be empty.",
      );
    });
  });

  describe('getDescription', () => {
    it('should return a description of the search', () => {
      const params: WebSearchToolParams = { query: 'test query' };
      const invocation = tool.build(params);
      expect(invocation.getDescription()).toBe(
        'Searching the web for: "test query"',
      );
    });
  });

  describe('execute', () => {
    it('should return search results for a successful query', async () => {
      const params: WebSearchToolParams = { query: 'successful query' };
      (mockGeminiClient.generateContent as Mock).mockResolvedValue({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'Here are your results.' }],
            },
          },
        ],
      });

      const invocation = tool.build(params);
      const result = await invocation.execute({ abortSignal });

      expect(result.llmContent).toBe(
        'Web search results for "successful query":\n\nHere are your results.' +
          WEB_SEARCH_CHAIN_HINT,
      );
      expect(result.returnDisplay).toBe(
        'Search results for "successful query" returned.',
      );
      expect(result.sources).toBeUndefined();
    });

    it('should fall back to independent search when Gemini returns empty text', async () => {
      const params: WebSearchToolParams = { query: 'OpenAgent terminal agent' };
      (mockGeminiClient.generateContent as Mock).mockResolvedValue({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: '' }],
            },
          },
        ],
      });

      const invocation = tool.build(params);
      const result = await invocation.execute({ abortSignal });

      // Independent backend should still return usable results
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('Web search results');
      expect(result.returnDisplay).toMatch(/returned/);
    });

    it('should fall back to independent search when Gemini throws', async () => {
      const params: WebSearchToolParams = { query: 'TypeScript handbook' };
      const testError = new Error('API Failure');
      (mockGeminiClient.generateContent as Mock).mockRejectedValue(testError);

      const invocation = tool.build(params);
      const result = await invocation.execute({ abortSignal });

      // Gemini failure must not hard-fail the tool when fallback works
      expect(result.error).toBeUndefined();
      expect(String(result.llmContent)).toContain('Web search results');
      expect(String(result.llmContent).toLowerCase()).not.toContain(
        'api failure',
      );
    });

    it('should correctly format results with sources and citations', async () => {
      const params: WebSearchToolParams = { query: 'grounding query' };
      (mockGeminiClient.generateContent as Mock).mockResolvedValue({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'This is a test response.' }],
            },
            groundingMetadata: {
              groundingChunks: [
                { web: { uri: 'https://example.com', title: 'Example Site' } },
                { web: { uri: 'https://google.com', title: 'Google' } },
              ],
              groundingSupports: [
                {
                  segment: { startIndex: 5, endIndex: 14 },
                  groundingChunkIndices: [0],
                },
                {
                  segment: { startIndex: 15, endIndex: 24 },
                  groundingChunkIndices: [0, 1],
                },
              ],
            },
          },
        ],
      });

      const invocation = tool.build(params);
      const result = await invocation.execute({ abortSignal });

      const expectedLlmContent =
        `Web search results for "grounding query":

This is a test[1] response.[1][2]

Sources:
[1] Example Site (https://example.com)
[2] Google (https://google.com)` + WEB_SEARCH_CHAIN_HINT;

      expect(result.llmContent).toBe(expectedLlmContent);
      expect(result.returnDisplay).toBe(
        'Search results for "grounding query" returned.',
      );
      expect(result.sources).toHaveLength(2);
    });

    it('should insert markers at correct byte positions for multibyte text', async () => {
      const params: WebSearchToolParams = { query: 'multibyte query' };
      (mockGeminiClient.generateContent as Mock).mockResolvedValue({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'こんにちは! Gemini CLI✨️' }],
            },
            groundingMetadata: {
              groundingChunks: [
                {
                  web: {
                    title: 'Japanese Greeting',
                    uri: 'https://example.test/japanese-greeting',
                  },
                },
                {
                  web: {
                    title: 'haseeb-heaven/open-agent',
                    uri: 'https://github.com/haseeb-heaven/open-agent',
                  },
                },
                {
                  web: {
                    title: 'Gemini CLI: your open-source AI agent',
                    uri: 'https://blog.google/technology/developers/introducing-gemini-cli-open-source-ai-agent/',
                  },
                },
              ],
              groundingSupports: [
                {
                  segment: {
                    // Byte range of "こんにちは!" (utf-8 encoded)
                    startIndex: 0,
                    endIndex: 16,
                  },
                  groundingChunkIndices: [0],
                },
                {
                  segment: {
                    // Byte range of "Gemini CLI✨️" (utf-8 encoded)
                    startIndex: 17,
                    endIndex: 33,
                  },
                  groundingChunkIndices: [1, 2],
                },
              ],
            },
          },
        ],
      });

      const invocation = tool.build(params);
      const result = await invocation.execute({ abortSignal });

      const expectedLlmContent =
        `Web search results for "multibyte query":

こんにちは![1] Gemini CLI✨️[2][3]

Sources:
[1] Japanese Greeting (https://example.test/japanese-greeting)
[2] haseeb-heaven/open-agent (https://github.com/haseeb-heaven/open-agent)
[3] Gemini CLI: your open-source AI agent (https://blog.google/technology/developers/introducing-gemini-cli-open-source-ai-agent/)` +
        WEB_SEARCH_CHAIN_HINT;

      expect(result.llmContent).toBe(expectedLlmContent);
      expect(result.returnDisplay).toBe(
        'Search results for "multibyte query" returned.',
      );
      expect(result.sources).toHaveLength(3);
    });
  });
});
