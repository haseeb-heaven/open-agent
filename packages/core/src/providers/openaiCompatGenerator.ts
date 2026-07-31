/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LiteLLM-style multi-provider routing implemented as a
 * {@link ContentGenerator}: translates Gemini `GenerateContentParameters`
 * to OpenAI-compatible chat completions and back, so every provider with
 * an OpenAI-compatible endpoint (Ollama, LM Studio, OpenAI, Groq,
 * DeepSeek, NVIDIA, Together, HuggingFace, OpenRouter, Cerebras, Z.ai,
 * Gemini's OpenAI endpoint, Anthropic via gateway) plugs into the CLI
 * without touching the rest of the codebase.
 */

import {
  GenerateContentResponse,
  FinishReason,
  type Content,
  type Part,
  type CountTokensParameters,
  type CountTokensResponse,
  type EmbedContentParameters,
  type EmbedContentResponse,
  type GenerateContentParameters,
  type FunctionDeclaration,
} from '@google/genai';
import type { ContentGenerator } from '../core/contentGenerator.js';
import {
  providerApiKey,
  splitModelId,
  type ProviderDefinition,
} from './providers.js';
import { recordProviderUsage } from './usageStore.js';
import { readCliEnvAlias } from '../utils/cliEnvAliases.js';

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | Array<Record<string, unknown>>;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface OpenAIChoiceDelta {
  role?: string;
  content?: string | null;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

export interface OpenAICompatOptions {
  /** LiteLLM-style model id, e.g. "ollama/llama3.1:8b" or "groq/llama-3.1-8b-instant". */
  modelId: string;
  provider: ProviderDefinition;
  /** Overrides the provider's default OpenAI-compatible base URL. */
  apiBase?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

/** Fast mode favors first response latency over long-form reasoning. */
const FAST_MODE_MAX_TOKENS = 1024;
const FAST_MODE_REQUEST_TIMEOUT_MS = 3000;

function contentsToList(
  contents: GenerateContentParameters['contents'],
): Content[] {
  if (Array.isArray(contents)) {
    return contents.map((c) =>
      typeof c === 'string'
        ? { role: 'user', parts: [{ text: c }] }
        : // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          (c as Content),
    );
  }
  if (typeof contents === 'string') {
    return [{ role: 'user', parts: [{ text: contents }] }];
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return [contents as Content];
}

function partText(part: Part): string | undefined {
  return typeof part.text === 'string' ? part.text : undefined;
}

/** Maps Gemini contents to OpenAI chat messages. */
export function toOpenAIMessages(
  request: GenerateContentParameters,
): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];

  const system = request.config?.systemInstruction;
  if (system) {
    const systemContents = contentsToList(
      system as GenerateContentParameters['contents'],
    );
    const text = systemContents
      .flatMap((c) => (c.parts ?? []).map(partText))
      .filter((t): t is string => Boolean(t))
      .join('\n');
    if (text) messages.push({ role: 'system', content: text });
  }

  for (const content of contentsToList(request.contents)) {
    const role = content.role === 'model' ? 'assistant' : 'user';
    const parts = content.parts ?? [];

    const toolCalls: NonNullable<OpenAIMessage['tool_calls']> = [];
    const toolResults: Array<{ id: string; output: string }> = [];
    const textParts: string[] = [];
    const imageParts: Array<Record<string, unknown>> = [];

    for (const part of parts) {
      const text = partText(part);
      if (text !== undefined) {
        textParts.push(text);
      } else if (part.functionCall) {
        toolCalls.push({
          id: part.functionCall.id ?? `call_${toolCalls.length}`,
          type: 'function',
          function: {
            name: part.functionCall.name ?? '',
            arguments: JSON.stringify(part.functionCall.args ?? {}),
          },
        });
      } else if (part.functionResponse) {
        toolResults.push({
          id: part.functionResponse.id ?? part.functionResponse.name ?? '',
          output: JSON.stringify(part.functionResponse.response ?? {}),
        });
      } else if (
        part.inlineData?.data &&
        (part.inlineData.mimeType ?? 'image/png').startsWith('image/')
      ) {
        // OpenAI-compatible chat-completions APIs only accept image/* as
        // image_url content; non-image attachments (e.g. PDFs) sent this way
        // get rejected outright by stricter backends (Cerebras, Groq).
        imageParts.push({
          type: 'image_url',
          image_url: {
            url: `data:${part.inlineData.mimeType ?? 'image/png'};base64,${part.inlineData.data}`,
          },
        });
      }
    }

    for (const result of toolResults) {
      messages.push({
        role: 'tool',
        tool_call_id: result.id,
        content: result.output,
      });
    }

    if (toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: textParts.length > 0 ? textParts.join('\n') : '',
        tool_calls: toolCalls,
      });
    } else if (imageParts.length > 0) {
      messages.push({
        role,
        content: [
          ...textParts.map((text) => ({ type: 'text', text })),
          ...imageParts,
        ],
      });
    } else if (textParts.length > 0) {
      messages.push({ role, content: textParts.join('\n') });
    }
  }
  return messages;
}

/** Maps Gemini tool declarations to OpenAI tool definitions. */
export function toOpenAITools(
  request: GenerateContentParameters,
): Array<Record<string, unknown>> | undefined {
  const tools = request.config?.tools;
  if (!tools) return undefined;
  const declarations: FunctionDeclaration[] = [];
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  for (const tool of tools as Array<{
    functionDeclarations?: FunctionDeclaration[];
  }>) {
    for (const decl of tool.functionDeclarations ?? []) {
      declarations.push(decl);
    }
  }
  if (declarations.length === 0) return undefined;
  return declarations.map((decl) => ({
    type: 'function',
    function: {
      name: decl.name,
      description: decl.description ?? '',
      parameters: decl.parametersJsonSchema ?? decl.parameters ?? {},
    },
  }));
}

function makeResponse(
  parts: Part[],
  options: {
    finishReason?: FinishReason;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
    modelVersion?: string;
  } = {},
): GenerateContentResponse {
  const response = {
    candidates: [
      {
        content: { role: 'model', parts },
        index: 0,
        ...(options.finishReason ? { finishReason: options.finishReason } : {}),
      },
    ],
    ...(options.usage
      ? {
          usageMetadata: {
            promptTokenCount: options.usage.prompt_tokens ?? 0,
            candidatesTokenCount: options.usage.completion_tokens ?? 0,
            totalTokenCount: options.usage.total_tokens ?? 0,
          },
        }
      : {}),
    ...(options.modelVersion ? { modelVersion: options.modelVersion } : {}),
  };
  Object.setPrototypeOf(response, GenerateContentResponse.prototype);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return response as GenerateContentResponse;
}

function mapFinishReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'length':
      return FinishReason.MAX_TOKENS;
    case 'content_filter':
      return FinishReason.SAFETY;
    case 'stop':
    case 'tool_calls':
    default:
      return FinishReason.STOP;
  }
}

/**
 * Builds an error thrown when a provider returns HTTP 200 but no content —
 * an empty/aborted SSE stream or a completion with no `message.content` and
 * no `tool_calls`. Common on overloaded free routers (OpenRouter/HF), and
 * previously surfaced as a silent "Thinking..." that disappears with no
 * output because the consumer treats an empty-parts response as a no-op.
 *
 * The message text intentionally includes "provider returned error" (a
 * `FREE_ROUTING_FAILURE_MARKERS` substring) so free-fallback classification
 * rotates to the next free model instead of stalling the session.
 */
function emptyResponseError(providerId: string, stream: boolean): Error {
  return new Error(
    `${providerId} ${stream ? 'stream' : 'request'} returned no content (provider returned error)`,
  );
}

/**
 * ContentGenerator that routes to any OpenAI-compatible endpoint.
 */
export class OpenAICompatContentGenerator implements ContentGenerator {
  private readonly fetchImpl: typeof fetch;
  readonly provider: ProviderDefinition;
  readonly model: string;
  readonly apiBase: string;
  private readonly apiKey?: string;
  private readonly temperature?: number;
  private readonly maxTokens?: number;
  private readonly fastMode: boolean;
  private readonly fastModeRequestTimeoutMs: number;

  constructor(options: OpenAICompatOptions) {
    this.provider = options.provider;
    // NVIDIA's own catalog ids are themselves "publisher/model" (e.g.
    // "nvidia/nemotron-3-super-120b-a12b", "meta/llama-3.1-70b-instruct"),
    // which collides with our routing-prefix convention when the publisher
    // happens to be "nvidia" — splitModelId would strip it as if it were
    // our provider prefix, sending a 404-ing bare model id. Keep the id
    // intact for this provider.
    this.model =
      options.provider.id === 'nvidia'
        ? options.modelId
        : splitModelId(options.modelId).model;
    this.apiBase = (options.apiBase ?? options.provider.apiBase).replace(
      /\/+$/,
      '',
    );
    this.apiKey =
      options.apiKey ?? providerApiKey(options.provider, options.env);
    this.temperature = options.temperature;
    this.maxTokens = options.maxTokens;
    this.fastMode = readCliEnvAlias('FAST_MODE', options.env) === '1';
    const configuredTimeout = Number(
      options.env?.['OPENAGENT_CLI_FAST_TIMEOUT_MS'],
    );
    this.fastModeRequestTimeoutMs =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : FAST_MODE_REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Set after a provider rejects tool definitions (e.g. HuggingFace router
   * models without function calling); later requests omit tools entirely.
   */
  private toolsUnsupported = false;

  private static isToolsUnsupportedError(
    status: number,
    detail: string,
  ): boolean {
    return (
      status === 400 &&
      /function.?call|tool/i.test(detail) &&
      /not.{0,10}support/i.test(detail)
    );
  }

  /**
   * POSTs to /chat/completions; when the provider answers 400 with a
   * "function calling not supported" error, retries once without tools.
   */
  private async postChat(
    request: GenerateContentParameters,
    stream: boolean,
  ): Promise<Response> {
    const callerSignal = request.config?.abortSignal;
    const timeoutSignal = this.fastMode
      ? AbortSignal.timeout(this.fastModeRequestTimeoutMs)
      : undefined;
    const signal = timeoutSignal
      ? callerSignal
        ? AbortSignal.any([callerSignal, timeoutSignal])
        : timeoutSignal
      : callerSignal;
    const attempt = (withTools: boolean) =>
      this.fetchImpl(`${this.apiBase}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(this.buildBody(request, stream, withTools)),
        ...(signal ? { signal } : {}),
      });
    let resp: Response;
    try {
      resp = await attempt(!this.toolsUnsupported);
    } catch (error) {
      if (timeoutSignal?.aborted && !callerSignal?.aborted) {
        throw new Error(
          `${this.provider.id} request deadline exceeded (provider returned error)`,
          { cause: error },
        );
      }
      throw error;
    }
    if (resp.ok) return resp;
    let detail = await resp.text().catch(() => '');
    if (
      !this.toolsUnsupported &&
      OpenAICompatContentGenerator.isToolsUnsupportedError(resp.status, detail)
    ) {
      this.toolsUnsupported = true;
      resp = await attempt(false);
      if (resp.ok) return resp;
      detail = await resp.text().catch(() => '');
    }
    throw new Error(
      `${this.provider.id} ${stream ? 'stream' : 'request'} failed (${resp.status}): ${detail.slice(0, 500)}`,
    );
  }

  private buildBody(
    request: GenerateContentParameters,
    stream: boolean,
    withTools = true,
  ): Record<string, unknown> {
    const tools = withTools ? toOpenAITools(request) : undefined;
    const configuredMaxTokens =
      request.config?.maxOutputTokens ?? this.maxTokens;
    const maxTokens = this.fastMode
      ? Math.min(
          configuredMaxTokens ?? FAST_MODE_MAX_TOKENS,
          FAST_MODE_MAX_TOKENS,
        )
      : configuredMaxTokens;

    return {
      model: this.model,
      messages: toOpenAIMessages(request),
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      temperature: request.config?.temperature ?? this.temperature ?? 0.1,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      ...(tools ? { tools } : {}),
    };
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  async generateContent(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role?: unknown,
  ): Promise<GenerateContentResponse> {
    const resp = await this.postChat(request, false);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const payload = (await resp.json()) as {
      choices?: Array<{
        message?: OpenAIChoiceDelta & {
          tool_calls?: Array<{
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
      model?: string;
    };
    const choice = payload.choices?.[0];
    const parts: Part[] = [];
    if (choice?.message?.content) {
      parts.push({ text: String(choice.message.content) });
    }
    for (const call of choice?.message?.tool_calls ?? []) {
      let args: Record<string, unknown> = {};
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        args = JSON.parse(call.function?.arguments || '{}') as Record<
          string,
          unknown
        >;
      } catch {
        // Malformed tool arguments: surface an empty args object.
      }
      parts.push({
        functionCall: {
          id: call.id,
          name: call.function?.name ?? '',
          args,
        },
      });
    }
    if (payload.usage) {
      try {
        recordProviderUsage(this.provider.id, {
          promptTokens: payload.usage.prompt_tokens,
          completionTokens: payload.usage.completion_tokens,
          totalTokens: payload.usage.total_tokens,
        });
      } catch {
        // Usage persistence must never break completions.
      }
    }
    // HTTP 200 but an empty completion (no text, no tool_calls) happens on
    // overloaded free routers; classify it as a routing failure so the free
    // fallback chain rotates to the next model instead of returning a
    // zero-parts response that silently ends the turn.
    if (parts.length === 0) {
      throw emptyResponseError(this.provider.id, false);
    }
    return makeResponse(parts, {
      finishReason: mapFinishReason(choice?.finish_reason),
      usage: payload.usage,
      modelVersion: payload.model ?? this.model,
    });
  }

  async generateContentStream(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role?: unknown,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const resp = await this.postChat(request, true);
    if (!resp.body) {
      throw new Error(`${this.provider.id} stream failed: empty body`);
    }
    const body = resp.body;
    const model = this.model;
    const providerId = this.provider.id;

    async function* stream(): AsyncGenerator<GenerateContentResponse> {
      const decoder = new TextDecoder();
      let buffer = '';
      // Streamed tool calls arrive fragmented; accumulate by a stable key.
      // Prefer call.id, then call.index (per the OpenAI streaming spec).
      // Some backends omit both on continuation chunks, in which case the
      // delta continues whichever tool call was last touched — defaulting
      // a missing index to a constant would otherwise merge distinct
      // parallel tool calls into one entry.
      const toolCalls = new Map<
        string,
        { id?: string; name: string; args: string; order: number }
      >();
      let toolCallOrder = 0;
      let lastToolCallKey: string | undefined;
      let usage:
        | {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
          }
        | undefined;
      let finish: string | undefined;

      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            let chunk: {
              choices?: Array<{
                delta?: OpenAIChoiceDelta;
                finish_reason?: string;
              }>;
              usage?: typeof usage;
            };
            try {
              // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
              chunk = JSON.parse(data) as typeof chunk;
            } catch {
              continue;
            }
            if (chunk.usage) usage = chunk.usage;
            const choice = chunk.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason) finish = choice.finish_reason;
            const delta = choice.delta;
            if (!delta) continue;
            if (delta.content) {
              yield makeResponse([{ text: delta.content }], {
                modelVersion: model,
              });
            }
            for (const call of delta.tool_calls ?? []) {
              let key: string;
              if (call.id) {
                key = `id:${call.id}`;
              } else if (call.index !== undefined) {
                key = `idx:${call.index}`;
              } else if (lastToolCallKey !== undefined) {
                key = lastToolCallKey;
              } else {
                key = `seq:${toolCallOrder}`;
              }
              let entry = toolCalls.get(key);
              if (!entry) {
                entry = { name: '', args: '', order: toolCallOrder++ };
                toolCalls.set(key, entry);
              }
              if (call.id) entry.id = call.id;
              if (call.function?.name) entry.name += call.function.name;
              if (call.function?.arguments) {
                entry.args += call.function.arguments;
              }
              lastToolCallKey = key;
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      const finalParts: Part[] = [];
      for (const [, call] of [...toolCalls.entries()].sort(
        (a, b) => a[1].order - b[1].order,
      )) {
        let args: Record<string, unknown> = {};
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          args = JSON.parse(call.args || '{}') as Record<string, unknown>;
        } catch {
          // Malformed streamed tool arguments: emit empty args.
        }
        finalParts.push({
          functionCall: { id: call.id, name: call.name, args },
        });
      }
      if (finalParts.length > 0 || usage || finish) {
        if (usage) {
          try {
            recordProviderUsage(providerId, {
              promptTokens: usage.prompt_tokens,
              completionTokens: usage.completion_tokens,
              totalTokens: usage.total_tokens,
            });
          } catch {
            // Usage persistence must never break completions.
          }
        }
        yield makeResponse(finalParts, {
          finishReason: mapFinishReason(finish),
          usage,
          modelVersion: model,
        });
      } else {
        // HTTP 200 but the SSE stream produced no deltas and no finish
        // reason (overloaded free router opened a connection then closed
        // it without emitting content). Previously this completed silently
        // and the agent stopped "thinking" with no output; classify it as
        // a routing failure so callers can fall back / surface an error.
        throw emptyResponseError(providerId, true);
      }
    }
    return stream();
  }

  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    // OpenAI-compatible endpoints expose no token counting; estimate at
    // ~4 characters per token, which is what LiteLLM falls back to.
    const text = JSON.stringify(request.contents ?? '');
    return { totalTokens: Math.ceil(text.length / 4) };
  }

  async embedContent(
    _request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    throw new Error(
      `embedContent is not supported for provider "${this.provider.id}".`,
    );
  }
}
