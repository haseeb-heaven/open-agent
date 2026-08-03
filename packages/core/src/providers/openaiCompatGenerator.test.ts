/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { Agent } from 'undici';
import {
  OpenAICompatContentGenerator,
  extractBashCommands,
  toOpenAIMessages,
  toOpenAITools,
} from './openaiCompatGenerator.js';
import { getProvider } from './providers.js';
import type { GenerateContentParameters } from '@google/genai';
import { SHELL_PARAM_COMMAND, SHELL_TOOL_NAME } from '../tools/tool-names.js';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(lines: string[]): Response {
  const body = lines.map((line) => `data: ${line}\n`).join('\n') + '\n';
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const REQUEST: GenerateContentParameters = {
  model: 'llama3.1:8b',
  contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
  config: {
    systemInstruction: { role: 'user', parts: [{ text: 'be brief' }] },
    temperature: 0.2,
    maxOutputTokens: 64,
  },
};

describe('toOpenAIMessages', () => {
  it('maps system instruction and user turns', () => {
    expect(toOpenAIMessages(REQUEST)).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('maps model turns with function calls to assistant tool_calls', () => {
    const messages = toOpenAIMessages({
      model: 'm',
      contents: [
        {
          role: 'model',
          parts: [
            { functionCall: { id: 'call_1', name: 'ls', args: { dir: '.' } } },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call_1',
                name: 'ls',
                response: { output: 'README.md' },
              },
            },
          ],
        },
      ],
    });
    expect(messages).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'ls', arguments: '{"dir":"."}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: '{"output":"README.md"}',
      },
    ]);
  });

  it('maps inline images to image_url content parts', () => {
    const messages = toOpenAIMessages({
      model: 'm',
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'what is this?' },
            { inlineData: { mimeType: 'image/png', data: 'aGk=' } },
          ],
        },
      ],
    });
    expect(messages[0].content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } },
    ]);
  });
});

describe('toOpenAITools', () => {
  it('maps function declarations to OpenAI tool definitions', () => {
    const tools = toOpenAITools({
      model: 'm',
      contents: 'x',
      config: {
        tools: [
          {
            functionDeclarations: [
              {
                name: 'read_file',
                description: 'Reads a file',
                parametersJsonSchema: { type: 'object' },
              },
            ],
          },
        ],
      },
    });
    expect(tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Reads a file',
          parameters: { type: 'object' },
        },
      },
    ]);
  });

  it('returns undefined without tools', () => {
    expect(toOpenAITools({ model: 'm', contents: 'x' })).toBeUndefined();
  });
});

describe('OpenAICompatContentGenerator', () => {
  it('turns a fast-mode request deadline into a free-routing failure', async () => {
    const fetchImpl = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );
    const generator = new OpenAICompatContentGenerator({
      modelId: 'ollama/llama3.1:8b',
      provider: getProvider('ollama')!,
      env: {
        OPENAGENT_CLI_FAST_MODE: '1',
        OPENAGENT_CLI_FAST_TIMEOUT_MS: '5',
      },
      fetchImpl,
    });

    await expect(
      generator.generateContent(REQUEST, 'prompt-id'),
    ).rejects.toThrow(/request deadline exceeded.*provider returned error/);
  });

  it('caps completion length in fast mode to reduce response latency', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: 'fast' }, finish_reason: 'stop' }],
      }),
    );
    const generator = new OpenAICompatContentGenerator({
      modelId: 'ollama/llama3.1:8b',
      provider: getProvider('ollama')!,
      maxTokens: 4096,
      env: { OPENAGENT_CLI_FAST_MODE: '1' },
      fetchImpl,
    });

    await generator.generateContent(
      {
        ...REQUEST,
        config: { ...REQUEST.config, maxOutputTokens: 4096 },
      },
      'prompt-id',
    );

    const body = JSON.parse(
      (fetchImpl.mock.calls[0][1] as { body: string }).body,
    );
    expect(body.max_tokens).toBe(1024);
  });

  it('routes generateContent through the provider base URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        model: 'llama3.1:8b',
        choices: [{ message: { content: 'hi there' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
    );
    const generator = new OpenAICompatContentGenerator({
      modelId: 'ollama/llama3.1:8b',
      provider: getProvider('ollama')!,
      fetchImpl,
    });
    const response = await generator.generateContent(REQUEST, 'prompt-id');

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:11434/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(
      (fetchImpl.mock.calls[0][1] as { body: string }).body,
    );
    expect(body.model).toBe('llama3.1:8b');
    expect(body.stream).toBe(false);
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(64);

    expect(response.candidates?.[0]?.content?.parts?.[0]?.text).toBe(
      'hi there',
    );
    expect(response.usageMetadata?.totalTokenCount).toBe(5);
  });

  it('retries without tools when the provider rejects function calling', async () => {
    const toolRequest: GenerateContentParameters = {
      ...REQUEST,
      config: {
        ...REQUEST.config,
        tools: [
          {
            functionDeclarations: [
              {
                name: 'read_file',
                description: 'read',
                parametersJsonSchema: {},
              },
            ],
          },
        ],
      },
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: 400,
            reason: 'INVALID_REQUEST_BODY',
            message: 'model features function calling not support',
          },
          400,
        ),
      )
      .mockImplementation(() =>
        Promise.resolve(
          jsonResponse({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          }),
        ),
      );
    const generator = new OpenAICompatContentGenerator({
      modelId: 'huggingface/meta-llama/Llama-3.1-8B-Instruct',
      provider: getProvider('huggingface')!,
      env: { HF_TOKEN: 'x' },
      fetchImpl,
    });

    const response = await generator.generateContent(toolRequest, 'prompt-id');
    expect(response.candidates?.[0]?.content?.parts?.[0]?.text).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const first = JSON.parse(
      (fetchImpl.mock.calls[0][1] as { body: string }).body,
    );
    const second = JSON.parse(
      (fetchImpl.mock.calls[1][1] as { body: string }).body,
    );
    expect(first.tools).toBeDefined();
    expect(second.tools).toBeUndefined();

    // Later calls skip tools immediately (no extra round-trip).
    await generator.generateContent(toolRequest, 'prompt-id');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const third = JSON.parse(
      (fetchImpl.mock.calls[2][1] as { body: string }).body,
    );
    expect(third.tools).toBeUndefined();
  });

  it('sends a Bearer key for cloud providers but none for local', async () => {
    const fetchImpl = vi.fn().mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        }),
      ),
    );
    const groq = new OpenAICompatContentGenerator({
      modelId: 'groq/llama-3.1-8b-instant',
      provider: getProvider('groq')!,
      env: { GROQ_API_KEY: 'gsk-test' },
      fetchImpl,
    });
    await groq.generateContent(REQUEST, 'p');
    const groqHeaders = (
      fetchImpl.mock.calls[0][1] as { headers: Record<string, string> }
    ).headers;
    expect(groqHeaders['Authorization']).toBe('Bearer gsk-test');

    const ollama = new OpenAICompatContentGenerator({
      modelId: 'ollama/llama3.1:8b',
      provider: getProvider('ollama')!,
      env: {},
      fetchImpl,
    });
    await ollama.generateContent(REQUEST, 'p');
    const ollamaHeaders = (
      fetchImpl.mock.calls[1][1] as { headers: Record<string, string> }
    ).headers;
    expect(ollamaHeaders['Authorization']).toBeUndefined();
  });

  it('forwards config.abortSignal to fetch so Esc actually cancels the request', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      }),
    );
    const generator = new OpenAICompatContentGenerator({
      modelId: 'ollama/llama3.1:8b',
      provider: getProvider('ollama')!,
      fetchImpl,
    });
    const controller = new AbortController();
    await generator.generateContent(
      {
        ...REQUEST,
        config: { ...REQUEST.config, abortSignal: controller.signal },
      },
      'p',
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('omits signal from fetch options when no abortSignal is set', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      }),
    );
    const generator = new OpenAICompatContentGenerator({
      modelId: 'ollama/llama3.1:8b',
      provider: getProvider('ollama')!,
      fetchImpl,
    });
    await generator.generateContent(REQUEST, 'p');
    const options = fetchImpl.mock.calls[0][1] as { signal?: AbortSignal };
    expect(options.signal).toBeUndefined();
  });

  it('maps tool_calls in responses to functionCall parts', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'call_9',
                  function: { name: 'ls', arguments: '{"dir":"/"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );
    const generator = new OpenAICompatContentGenerator({
      modelId: 'ollama/llama3.1:8b',
      provider: getProvider('ollama')!,
      fetchImpl,
    });
    const response = await generator.generateContent(REQUEST, 'p');
    expect(response.candidates?.[0]?.content?.parts?.[0]?.functionCall).toEqual(
      { id: 'call_9', name: 'ls', args: { dir: '/' } },
    );
  });

  it('throws a provider-tagged error on HTTP failures', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }));
    const generator = new OpenAICompatContentGenerator({
      modelId: 'groq/llama-3.1-8b-instant',
      provider: getProvider('groq')!,
      env: { GROQ_API_KEY: 'x' },
      fetchImpl,
    });
    await expect(generator.generateContent(REQUEST, 'p')).rejects.toThrow(
      /groq request failed \(429\)/,
    );
  });

  it('streams text deltas and trailing usage', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      sseResponse([
        JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
        '[DONE]',
      ]),
    );
    const generator = new OpenAICompatContentGenerator({
      modelId: 'ollama/llama3.1:8b',
      provider: getProvider('ollama')!,
      fetchImpl,
    });
    const chunks = [];
    for await (const chunk of await generator.generateContentStream(
      REQUEST,
      'p',
    )) {
      chunks.push(chunk);
    }
    const texts = chunks
      .map((c) => c.candidates?.[0]?.content?.parts?.[0]?.text)
      .filter(Boolean);
    expect(texts).toEqual(['Hel', 'lo']);
    expect(chunks.at(-1)?.usageMetadata?.totalTokenCount).toBe(3);
  });

  it('keeps parallel streamed tool calls distinct when index is missing', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      sseResponse([
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: 'call_a',
                    function: { name: 'google_web_search', arguments: '' },
                  },
                ],
              },
            },
          ],
        }),
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: 'call_b',
                    function: { name: 'ask_user', arguments: '' },
                  },
                ],
              },
            },
          ],
        }),
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { id: 'call_a', function: { arguments: '{"q":"x"}' } },
                ],
              },
            },
          ],
        }),
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { id: 'call_b', function: { arguments: '{"q":"y"}' } },
                ],
              },
            },
          ],
        }),
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        }),
        '[DONE]',
      ]),
    );
    const generator = new OpenAICompatContentGenerator({
      modelId: 'ollama/llama3.1:8b',
      provider: getProvider('ollama')!,
      fetchImpl,
    });
    const chunks = [];
    for await (const chunk of await generator.generateContentStream(
      REQUEST,
      'p',
    )) {
      chunks.push(chunk);
    }
    const functionCalls = chunks
      .at(-1)
      ?.candidates?.[0]?.content?.parts?.map((p) => p.functionCall)
      .filter(Boolean);
    expect(functionCalls).toEqual([
      { id: 'call_a', name: 'google_web_search', args: { q: 'x' } },
      { id: 'call_b', name: 'ask_user', args: { q: 'y' } },
    ]);
  });

  it('estimates countTokens and rejects embedContent', async () => {
    const generator = new OpenAICompatContentGenerator({
      modelId: 'ollama/llama3.1:8b',
      provider: getProvider('ollama')!,
      fetchImpl: vi.fn(),
    });
    const counted = await generator.countTokens({
      model: 'm',
      contents: [{ role: 'user', parts: [{ text: 'x'.repeat(40) }] }],
    });
    expect(counted.totalTokens).toBeGreaterThan(0);
    await expect(
      generator.embedContent({ model: 'm', contents: [] }),
    ).rejects.toThrow(/not supported/);
  });

  it('throws when a 200 completion has no text and no tool calls (silent-stall guard)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: null }, finish_reason: 'stop' }],
        model: 'whatever',
      }),
    );
    const generator = new OpenAICompatContentGenerator({
      modelId: 'ollama/llama3.1:8b',
      provider: getProvider('ollama')!,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(generator.generateContent(REQUEST, 'p')).rejects.toThrow(
      /returned no content/,
    );
  });

  it('throws when a 200 SSE stream emits no content and no finish (aborted free stream)', async () => {
    // Overloaded free routers commonly open 200 then immediately close
    // with only the [DONE] sentinel and no deltas. Previously this
    // completed silently and the agent stopped "thinking" with no output.
    const fetchImpl = vi.fn(async () => sseResponse(['[DONE]']));
    const generator = new OpenAICompatContentGenerator({
      modelId: 'ollama/llama3.1:8b',
      provider: getProvider('ollama')!,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const stream = await generator.generateContentStream(REQUEST, 'p');
    const chunks: unknown[] = [];
    await expect(
      (async () => {
        for await (const chunk of stream) chunks.push(chunk);
      })(),
    ).rejects.toThrow(/stream returned no content/);
    expect(chunks).toHaveLength(0);
  });
});

describe('bash-fence text tool protocol (local models)', () => {
  const AGENT_REQUEST: GenerateContentParameters = {
    model: 'ollama/qwen2.5:1.5b',
    contents: [{ role: 'user', parts: [{ text: 'run something' }] }],
    config: {
      systemInstruction: { role: 'user', parts: [{ text: 'be brief' }] },
      tools: [
        {
          functionDeclarations: [
            {
              name: SHELL_TOOL_NAME,
              description: 'Runs a shell command',
              parametersJsonSchema: {
                type: 'object',
                properties: { [SHELL_PARAM_COMMAND]: { type: 'string' } },
                required: [SHELL_PARAM_COMMAND],
              },
            },
          ],
        },
      ],
    },
  };

  function functionCallsOf(response: {
    candidates?: Array<{
      content?: { parts?: Array<{ functionCall?: unknown }> };
    }>;
  }) {
    return (
      response.candidates?.[0]?.content?.parts
        ?.map((part) => part.functionCall)
        .filter(Boolean) ?? []
    );
  }

  it('extractBashCommands pulls commands out of fenced blocks', () => {
    expect(
      extractBashCommands('Here:\n```bash\nsw_vers -productVersion\n```\ndone'),
    ).toEqual(['sw_vers -productVersion']);
    expect(
      extractBashCommands('```sh\nls -la\n``` and ```shell\necho hi\n```'),
    ).toEqual(['ls -la', 'echo hi']);
    expect(extractBashCommands('no fences anywhere')).toEqual([]);
    expect(extractBashCommands('```python\nprint(1)\n```')).toEqual([]);
  });

  it('synthesizes a run_shell_command call from a bash-fenced text reply', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        choices: [
          {
            message: {
              content: 'Running now:\n```bash\nsw_vers -productVersion\n```',
            },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    const generator = new OpenAICompatContentGenerator({
      modelId: 'ollama/qwen2.5:1.5b',
      provider: getProvider('ollama')!,
      fetchImpl,
    });
    const response = await generator.generateContent(AGENT_REQUEST, 'p');
    expect(functionCallsOf(response)).toEqual([
      {
        id: 'text_bash_1',
        name: SHELL_TOOL_NAME,
        args: { [SHELL_PARAM_COMMAND]: 'sw_vers -productVersion' },
      },
    ]);
  });

  it('synthesizes run_shell_command calls from streamed bash-fenced text', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      sseResponse([
        JSON.stringify({
          choices: [
            {
              delta: {
                content:
                  'Info:\n```bash\nsysctl -n hw.memsize\n```\n```bash\npwd\n```',
              },
            },
          ],
        }),
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
        }),
        '[DONE]',
      ]),
    );
    const generator = new OpenAICompatContentGenerator({
      modelId: 'ollama/qwen2.5:1.5b',
      provider: getProvider('ollama')!,
      fetchImpl,
    });
    const chunks: Array<{
      candidates?: Array<{
        content?: { parts?: Array<{ functionCall?: unknown }> };
      }>;
    }> = [];
    for await (const chunk of await generator.generateContentStream(
      AGENT_REQUEST,
      'p',
    )) {
      chunks.push(chunk);
    }
    expect(functionCallsOf(chunks.at(-1) as never)).toEqual([
      {
        id: 'text_bash_1',
        name: SHELL_TOOL_NAME,
        args: { [SHELL_PARAM_COMMAND]: 'sysctl -n hw.memsize' },
      },
      {
        id: 'text_bash_2',
        name: SHELL_TOOL_NAME,
        args: { [SHELL_PARAM_COMMAND]: 'pwd' },
      },
    ]);
  });

  it('does not synthesize for plain chat without tools', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        choices: [
          {
            message: {
              content: 'For example:\n```bash\npwd\n```',
            },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    const generator = new OpenAICompatContentGenerator({
      modelId: 'ollama/qwen2.5:1.5b',
      provider: getProvider('ollama')!,
      fetchImpl,
    });
    const response = await generator.generateContent(REQUEST, 'p');
    expect(functionCallsOf(response)).toEqual([]);
  });

  it('does not synthesize for cloud providers', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        choices: [
          {
            message: {
              content: '```bash\npwd\n```',
            },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    const generator = new OpenAICompatContentGenerator({
      modelId: 'groq/llama-3.1-8b-instant',
      provider: getProvider('groq')!,
      env: { GROQ_API_KEY: 'x' },
      fetchImpl,
    });
    const response = await generator.generateContent(AGENT_REQUEST, 'p');
    expect(functionCallsOf(response)).toEqual([]);
  });

  it('prefers real tool_calls over fenced text', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        choices: [
          {
            message: {
              content: '```bash\npwd\n```',
              tool_calls: [
                {
                  id: 'call_9',
                  function: { name: 'ls', arguments: '{"dir":"/"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );
    const generator = new OpenAICompatContentGenerator({
      modelId: 'ollama/qwen2.5:1.5b',
      provider: getProvider('ollama')!,
      fetchImpl,
    });
    const response = await generator.generateContent(AGENT_REQUEST, 'p');
    expect(functionCallsOf(response)).toEqual([
      { id: 'call_9', name: 'ls', args: { dir: '/' } },
    ]);
  });

  it('appends the protocol hint and keep_alive to local requests', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      }),
    );
    const generator = new OpenAICompatContentGenerator({
      modelId: 'ollama/qwen2.5:1.5b',
      provider: getProvider('ollama')!,
      fetchImpl,
    });
    await generator.generateContent(AGENT_REQUEST, 'p');
    const body = JSON.parse(
      (fetchImpl.mock.calls[0][1] as { body: string }).body,
    ) as { keep_alive?: string; tools?: unknown; messages: unknown[] };
    expect(body.keep_alive).toBe('30m');
    expect(body.tools).toBeDefined();
    expect(body.messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('fenced code block tagged bash'),
    });
  });

  it('keeps the hint and drops tools after a "does not support tools" retry', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message:
                'registry.ollama.ai/library/smollm2:135m does not support tools',
            },
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              message: {
                content: '```bash\npwd\n```',
              },
              finish_reason: 'stop',
            },
          ],
        }),
      );
    const generator = new OpenAICompatContentGenerator({
      modelId: 'ollama/smollm2:135m',
      provider: getProvider('ollama')!,
      fetchImpl,
    });
    const response = await generator.generateContent(AGENT_REQUEST, 'p');
    const bodies = fetchImpl.mock.calls.map((call) =>
      JSON.parse((call[1] as { body: string }).body),
    ) as Array<{ tools?: unknown; messages: unknown[] }>;
    expect(bodies).toHaveLength(2);
    expect(bodies[0].tools).toBeDefined();
    expect(bodies[1].tools).toBeUndefined();
    expect(bodies[1].messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('fenced code block tagged bash'),
    });
    expect(functionCallsOf(response)).toEqual([
      {
        id: 'text_bash_1',
        name: SHELL_TOOL_NAME,
        args: { [SHELL_PARAM_COMMAND]: 'pwd' },
      },
    ]);
  });

  it('uses a dedicated long-timeout dispatcher when no fetchImpl is supplied', async () => {
    // The app-wide undici dispatcher applies a short (60s) headersTimeout to
    // fail fast on hung cloud requests. Slow local / LAN Ollama models must not
    // inherit that and get spuriously aborted as `TypeError: fetch failed`.
    // Regression guard: the default path must attach its own dispatcher.
    const globalFetch = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      }),
    );
    vi.stubGlobal('fetch', globalFetch);
    try {
      const generator = new OpenAICompatContentGenerator({
        modelId: 'ollama/gemma2:2b',
        provider: getProvider('ollama')!,
      });
      await generator.generateContent(REQUEST, 'prompt-id');

      const suppliedDispatcher = (
        globalFetch.mock.calls[0][1] as { dispatcher?: unknown }
      ).dispatcher;
      expect(suppliedDispatcher).toBeInstanceOf(Agent);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
