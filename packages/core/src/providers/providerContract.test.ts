/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { Type, type GenerateContentParameters } from '@google/genai';
import { ModelRegistry } from './modelRegistry.js';
import { resolveProviderRoute } from './resolve.js';
import {
  createMultiProviderGenerator,
  isMultiProviderModel,
} from './factory.js';
import { OpenAICompatContentGenerator } from './openaiCompatGenerator.js';
import { getProvider } from './providers.js';
import { LlmRole } from '../telemetry/llmRole.js';
import { z } from 'zod';

const registry = ModelRegistry.load(
  new URL('../../../../configs/models.toml', import.meta.url).pathname,
);

describe('provider catalog contract', () => {
  it.each([
    ['claude-opus-5', 'claude-opus-5', 'anthropic'],
    ['claude-fable-5-1', 'claude-fable-5-1', 'anthropic'],
    ['gemini-3.8-flash', 'gemini/gemini-3.8-flash', 'gemini'],
    ['gemini-3.1-flash-lite', 'gemini/gemini-3.1-flash-lite', 'gemini'],
  ])(
    'resolves %s through its configured provider',
    async (key, modelId, providerId) => {
      expect(registry.getModel(key)?.model).toBe(modelId);
      expect(isMultiProviderModel(key, registry)).toBe(providerId !== 'gemini');
      const route = await resolveProviderRoute({
        model: key,
        registry,
        env: { ANTHROPIC_API_KEY: 'test-only' },
        allowUnavailable: true,
      });
      expect(route?.provider.id).toBe(providerId);
      expect(route?.modelId).toBe(modelId);
      if (providerId === 'gemini') {
        expect(createMultiProviderGenerator(key, {}, registry)).toBeUndefined();
      } else {
        expect(
          createMultiProviderGenerator(
            key,
            { ANTHROPIC_API_KEY: 'test-only' },
            registry,
          ),
        ).toBeInstanceOf(OpenAICompatContentGenerator);
      }
    },
  );

  it('does not retain the retired Gemini preview registry key', () => {
    expect(registry.hasModel('gemini-3.1-flash-lite-preview')).toBe(false);
  });

  it('sends a fake-fetch request with provider URL, auth, and tools, then maps its tool call', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'call_lookup',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{"key":"status"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );
    const generator = new OpenAICompatContentGenerator({
      modelId: 'anthropic/claude-opus-5',
      provider: getProvider('anthropic')!,
      env: { ANTHROPIC_API_KEY: 'test-only' },
      fetchImpl,
    });
    const request: GenerateContentParameters = {
      model: 'claude-opus-5',
      contents: 'Look up status',
      config: {
        tools: [
          {
            functionDeclarations: [
              { name: 'lookup', parameters: { type: Type.OBJECT } },
            ],
          },
        ],
      },
    };
    const response = await generator.generateContent(
      request,
      'contract',
      LlmRole.MAIN,
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-only' }),
      }),
    );
    const body = z
      .object({
        model: z.string(),
        tools: z.array(z.object({ function: z.object({ name: z.string() }) })),
      })
      .parse(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as unknown);
    expect(body.model).toBe('claude-opus-5');
    expect(body.tools[0]?.function.name).toBe('lookup');
    expect(response.candidates?.[0]?.content?.parts?.[0]?.functionCall).toEqual(
      {
        id: 'call_lookup',
        name: 'lookup',
        args: { key: 'status' },
      },
    );
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
