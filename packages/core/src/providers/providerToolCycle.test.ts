/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Type, type GenerateContentParameters } from '@google/genai';
import { createMultiProviderGenerator } from './factory.js';
import { ModelRegistry } from './modelRegistry.js';
import { LlmRole } from '../telemetry/llmRole.js';
import { z } from 'zod';

const registry = ModelRegistry.load(
  new URL('../../../../configs/models.toml', import.meta.url).pathname,
);

describe('provider tool protocol cycle', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('runs a fake operation between provider tool request and completed resumed answer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 'call_status',
                    type: 'function',
                    function: {
                      name: 'read_status',
                      arguments: '{"service":"demo"}',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              message: { content: 'The demo service is ready.' },
              finish_reason: 'stop',
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const generator = createMultiProviderGenerator(
      'claude-opus-5',
      { ANTHROPIC_API_KEY: 'test-only' },
      registry,
    );
    if (!generator)
      throw new Error('Expected Anthropic route from model registry');

    const request: GenerateContentParameters = {
      model: 'claude-opus-5',
      contents: 'Check demo service status.',
      config: {
        tools: [
          {
            functionDeclarations: [
              {
                name: 'read_status',
                description: 'Read a fixed in-memory status.',
                parameters: {
                  type: Type.OBJECT,
                  properties: { service: { type: Type.STRING } },
                },
              },
            ],
          },
        ],
      },
    };
    const toolRequest = await generator.generateContent(
      request,
      'tool-cycle',
      LlmRole.MAIN,
    );
    const call = toolRequest.candidates?.[0]?.content?.parts?.[0]?.functionCall;
    expect(call).toEqual({
      id: 'call_status',
      name: 'read_status',
      args: { service: 'demo' },
    });

    const fakeOperation = (args: unknown) => {
      expect(args).toEqual({ service: 'demo' });
      return { status: 'ready' };
    };
    const toolResult = fakeOperation(call?.args);
    const response = await generator.generateContent(
      {
        ...request,
        contents: [
          { role: 'user', parts: [{ text: 'Check demo service status.' }] },
          { role: 'model', parts: [{ functionCall: call }] },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: call?.id,
                  name: call?.name,
                  response: toolResult,
                },
              },
            ],
          },
        ],
      },
      'tool-cycle',
      LlmRole.MAIN,
    );

    expect(response.candidates?.[0]?.content?.parts?.[0]?.text).toBe(
      'The demo service is ready.',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.every(
        ([url]) => url === 'https://api.anthropic.com/v1/chat/completions',
      ),
    ).toBe(true);
    const resumedBody = z
      .object({
        messages: z.array(
          z.object({
            role: z.string(),
            tool_call_id: z.string().optional(),
            content: z.string().optional(),
          }),
        ),
      })
      .parse(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as unknown);
    expect(resumedBody.messages).toContainEqual(
      expect.objectContaining({
        role: 'tool',
        tool_call_id: 'call_status',
        content: '{"status":"ready"}',
      }),
    );
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
