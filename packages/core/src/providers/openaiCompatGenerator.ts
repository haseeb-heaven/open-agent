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
import { Agent as UndiciAgent } from 'undici';
import type { ContentGenerator } from '../core/contentGenerator.js';
import {
  providerApiKey,
  splitModelId,
  type ProviderDefinition,
} from './providers.js';
import { recordProviderUsage } from './usageStore.js';
import { readCliEnvAlias } from '../utils/cliEnvAliases.js';
import { SHELL_TOOL_NAME, SHELL_PARAM_COMMAND } from '../tools/tool-names.js';

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

/**
 * How long to keep a local model server's KV cache warm between turns.
 * Ollama/LM Studio default to a short unload window; keeping the model
 * resident lets repeated requests reuse the cached prompt prefix (the
 * bulk of every local request), cutting per-turn prefill latency.
 */
const LOCAL_KEEP_ALIVE = '30m';

/**
 * How long a provider /chat/completions fetch may take before it is aborted.
 * Local (and LAN-hosted) Ollama / LM Studio models can be much slower to emit
 * their first SSE byte than cloud APIs: a cold model load plus the prefill of
 * OpenAgent's large system prompt on a small GPU routinely exceeds the 60s
 * `headersTimeout` that the app-wide undici dispatcher (see utils/fetch.ts)
 * applies to fail fast on hung cloud requests. That aggressive timeout destroys
 * the connection of an otherwise-healthy local generation, which surfaces to
 * the user as a raw `TypeError: fetch failed` even though curl to the same
 * server succeeds. Route provider requests through a dedicated dispatcher with
 * generous timeouts (same idiom as the A2A client manager) so slow-but-working
 * local models are not spuriously aborted.
 */
const PROVIDER_FETCH_HEADERS_TIMEOUT_MS = 30 * 60 * 1000; // 30 min to first byte
const PROVIDER_FETCH_BODY_TIMEOUT_MS = 60 * 60 * 1000; // 60 min to stream body

/** Dedicated undici dispatcher for OpenAI-compatible provider requests. */
const providerDispatcher = new UndiciAgent({
  headersTimeout: PROVIDER_FETCH_HEADERS_TIMEOUT_MS,
  bodyTimeout: PROVIDER_FETCH_BODY_TIMEOUT_MS,
});

/** `fetch` bound to {@link providerDispatcher}, used as the default fetch impl. */
function providerFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return fetch(input, {
    ...init,
    dispatcher: providerDispatcher,
  } as RequestInit);
}

/**
 * Instruction appended to local-provider requests whose models cannot be
 * relied on for OpenAI-style function calling (either the server rejects
 * tools outright, or the model is too small to emit valid tool calls).
 * The model writes a `bash` fenced block instead, which the client parses
 * and executes as a real {@link SHELL_TOOL_NAME} call. The platform
 * examples keep small models from reaching for Linux-only commands on
 * macOS/Windows.
 */
function textToolProtocolHint(): string {
  const platform = process.platform;
  const examples =
    platform === 'darwin'
      ? 'Use macOS commands, e.g. `sw_vers -productVersion` (OS version), `sysctl -n hw.memsize` (total RAM in bytes), `pwd` (working directory).'
      : platform === 'win32'
        ? 'Use Windows commands, e.g. `ver`, `wmic ComputerSystem get TotalPhysicalMemory`, `cd`.'
        : 'Use Linux commands, e.g. `uname -a`, `free -h`, `pwd`.';
  return `If you need to execute a shell command, put the exact command in a fenced code block tagged bash:
\`\`\`bash
echo hello
\`\`\`
The system executes it and returns the output, which you then report. Never invent command output; always wait for the execution result. ${examples}`;
}

/** Matches fenced bash blocks, e.g. ```` ```bash\nls -la\n``` ````. */
const BASH_FENCE_RE = /```(?:bash|sh|shell|zsh)\s*\r?\n([\s\S]*?)```/g;

/** Extracts the contents of every bash-fenced block in `text`. */
export function extractBashCommands(text: string): string[] {
  const commands: string[] = [];
  const re = new RegExp(BASH_FENCE_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const command = (match[1] ?? '').trim();
    // Cap at a generous command length; pathological outputs must never
    // grow into unbounded tool payloads.
    if (command && command.length <= 8192) {
      commands.push(command);
    }
  }
  return commands;
}

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
    // Local providers (Ollama / LM Studio) get a dedicated undici dispatcher
    // with generous timeouts: cold model loads + prefill of a large system
    // prompt can take far longer than the 60s app-wide headersTimeout (utils/
    // fetch.ts), which would otherwise abort otherwise-healthy local
    // generations as `TypeError: fetch failed`. Cloud providers keep the
    // global dispatcher so genuinely hung free routers still fail fast and
    // fall through the routing chain instead of blocking for minutes.
    this.fetchImpl =
      options.fetchImpl ?? (options.provider.local ? providerFetch : fetch);
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

    const messages = toOpenAIMessages(request);
    if (this.textToolProtocolEnabled(request)) {
      // Trailing user message keeps the protocol instruction at the end of
      // the prompt, where small local models (and prompt truncation) see it.
      messages.push({ role: 'user', content: textToolProtocolHint() });
    }

    return {
      model: this.model,
      messages,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      temperature: request.config?.temperature ?? this.temperature ?? 0.1,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      ...(tools ? { tools } : {}),
      ...(this.provider.local ? { keep_alive: LOCAL_KEEP_ALIVE } : {}),
    };
  }

  /**
   * Whether the bash-fence text protocol applies to this request: only
   * local (Ollama/LM Studio) providers, and only when the request actually
   * carries tools (agent mode). Plain chat stays untouched. Applies both
   * when tools are sent and after a "tools not supported" retry — the
   * retry path is exactly when the model must fall back to text fences.
   */
  private textToolProtocolEnabled(request: GenerateContentParameters): boolean {
    return this.provider.local && this.requestHasTools(request);
  }

  private requestHasTools(request: GenerateContentParameters): boolean {
    return (toOpenAITools(request)?.length ?? 0) > 0;
  }

  /**
   * Converts bash-fenced blocks found in a model's plain-text reply into
   * real {@link SHELL_TOOL_NAME} function calls, so local models without
   * reliable function calling can still drive command execution through
   * the normal tool/approval pipeline. Returns only the synthesized calls;
   * no-op when the model already emitted function calls.
   */
  private synthesizeBashToolCalls(parts: Part[]): Part[] {
    if (parts.some((part) => part.functionCall)) {
      return [];
    }
    const text = parts
      .map((part) => part.text)
      .filter((t): t is string => typeof t === 'string')
      .join('\n');
    if (!text) return [];
    const commands = extractBashCommands(text);
    return commands.map((command, i) => ({
      functionCall: {
        id: `text_bash_${i + 1}`,
        name: SHELL_TOOL_NAME,
        args: { [SHELL_PARAM_COMMAND]: command },
      },
    }));
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
    if (this.textToolProtocolEnabled(request)) {
      parts.push(...this.synthesizeBashToolCalls(parts));
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
    const textProtocolEnabled = this.textToolProtocolEnabled(request);

    async function* stream(): AsyncGenerator<GenerateContentResponse> {
      const decoder = new TextDecoder();
      let buffer = '';
      let streamedText = '';
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
              streamedText += delta.content;
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
      if (textProtocolEnabled && finalParts.length === 0 && streamedText) {
        for (const command of extractBashCommands(streamedText)) {
          finalParts.push({
            functionCall: {
              id: `text_bash_${finalParts.length + 1}`,
              name: SHELL_TOOL_NAME,
              args: { [SHELL_PARAM_COMMAND]: command },
            },
          });
        }
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
