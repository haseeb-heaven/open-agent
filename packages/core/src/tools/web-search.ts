/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { WEB_SEARCH_TOOL_NAME, WEB_SEARCH_DISPLAY_NAME } from './tool-names.js';
import type { GroundingMetadata } from '@google/genai';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
  type ExecuteOptions,
} from './tools.js';
import { ToolErrorType } from './tool-error.js';

import { getErrorMessage, isAbortError } from '../utils/errors.js';
import { getResponseText } from '../utils/partUtils.js';
import { debugLogger } from '../utils/debugLogger.js';
import { WEB_SEARCH_DEFINITION } from './definitions/coreTools.js';
import { resolveToolDeclaration } from './definitions/resolver.js';
import { LlmRole } from '../telemetry/llmRole.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import type { Config } from '../config/config.js';
import type { GeminiClient } from '../core/client.js';
import {
  executeWebSearchHttp,
  planWebSearchRoute,
  hasGeminiSearchKey,
} from '../websearch/index.js';

interface GroundingChunkWeb {
  uri?: string;
  title?: string;
}

interface GroundingChunkItem {
  web?: GroundingChunkWeb;
}

interface GroundingSupportSegment {
  startIndex: number;
  endIndex: number;
  text?: string;
}

interface GroundingSupportItem {
  segment?: GroundingSupportSegment;
  groundingChunkIndices?: number[];
  confidenceScores?: number[];
}

/**
 * Parameters for the WebSearchTool.
 */
export interface WebSearchToolParams {
  /**
   * The search query.
   */
  query: string;
}

/**
 * Extends ToolResult to include sources for web search.
 */
export interface WebSearchToolResult extends ToolResult {
  sources?: GroundingMetadata extends { groundingChunks: GroundingChunkItem[] }
    ? GroundingMetadata['groundingChunks']
    : GroundingChunkItem[];
}

/**
 * Appended to successful search results so weaker models keep chaining tools
 * (fetch page content, download files via shell, open/run, etc.) instead of
 * stopping after the first hit list. Generic — no domain hardcoding.
 */
export const WEB_SEARCH_CHAIN_HINT = `

---
Multi-step continuation (do not stop after search alone):
- If the user only wanted facts/links, answer from these results.
- To read/summarize a page: call web_fetch with prompt containing the full https URL and instructions (web_fetch does NOT save files to disk).
- To save a file to disk: call run_shell_command (curl / Invoke-WebRequest / wget) with the direct download URL and destination path. Never invent web_fetch download_location/save_path params.
- Then continue with any further actions the user asked for (open, install, extract, verify, edit, etc.) in the same tool-use loop until the request is complete.
`;

function isConfigLike(ctx: AgentLoopContext | Config): ctx is Config {
  return 'getGeminiClient' in ctx && typeof ctx.getGeminiClient === 'function';
}

function isAgentLoopContext(
  ctx: AgentLoopContext | Config,
): ctx is AgentLoopContext {
  return (
    'config' in ctx &&
    'geminiClient' in ctx &&
    'toolRegistry' in ctx &&
    'promptId' in ctx
  );
}

/**
 * Resolve GeminiClient from either a full AgentLoopContext or a bare Config
 * (how the tool is registered in production).
 */
function resolveGeminiClient(
  ctx: AgentLoopContext | Config | undefined,
): GeminiClient | undefined {
  if (!ctx) return undefined;
  if (isAgentLoopContext(ctx)) {
    return ctx.geminiClient;
  }
  if (isConfigLike(ctx)) {
    try {
      return ctx.getGeminiClient();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

class WebSearchToolInvocation extends BaseToolInvocation<
  WebSearchToolParams,
  WebSearchToolResult
> {
  constructor(
    private readonly context: AgentLoopContext | Config,
    params: WebSearchToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
  }

  override getDescription(): string {
    return `Searching the web for: "${this.params.query}"`;
  }

  /**
   * Gemini Google Search grounding when a GeminiClient is available.
   * Falls back to independent search on failure / empty response.
   */
  private async executeGeminiSearch(
    signal: AbortSignal,
  ): Promise<WebSearchToolResult | null> {
    const geminiClient = resolveGeminiClient(this.context);
    if (!geminiClient) {
      return null;
    }

    try {
      const response = await geminiClient.generateContent(
        { model: 'web-search' },
        [{ role: 'user', parts: [{ text: this.params.query }] }],
        signal,
        LlmRole.UTILITY_TOOL,
      );

      const responseText = getResponseText(response);
      const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
      const sources = groundingMetadata?.groundingChunks as
        | GroundingChunkItem[]
        | undefined;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const groundingSupports = groundingMetadata?.groundingSupports as
        | GroundingSupportItem[]
        | undefined;

      if (!responseText || !responseText.trim()) {
        return null; // fall through to independent search
      }

      let modifiedResponseText = responseText;
      const sourceListFormatted: string[] = [];

      if (sources && sources.length > 0) {
        sources.forEach((source: GroundingChunkItem, index: number) => {
          const title = source.web?.title || 'Untitled';
          const uri = source.web?.uri || 'No URI';
          sourceListFormatted.push(`[${index + 1}] ${title} (${uri})`);
        });

        if (groundingSupports && groundingSupports.length > 0) {
          const insertions: Array<{ index: number; marker: string }> = [];
          groundingSupports.forEach((support: GroundingSupportItem) => {
            if (support.segment && support.groundingChunkIndices) {
              const citationMarker = support.groundingChunkIndices
                .map((chunkIndex: number) => `[${chunkIndex + 1}]`)
                .join('');
              insertions.push({
                index: support.segment.endIndex,
                marker: citationMarker,
              });
            }
          });

          insertions.sort((a, b) => b.index - a.index);

          const encoder = new TextEncoder();
          const responseBytes = encoder.encode(modifiedResponseText);
          const parts: Uint8Array[] = [];
          let lastIndex = responseBytes.length;
          for (const ins of insertions) {
            const pos = Math.min(ins.index, lastIndex);
            parts.unshift(responseBytes.subarray(pos, lastIndex));
            parts.unshift(encoder.encode(ins.marker));
            lastIndex = pos;
          }
          parts.unshift(responseBytes.subarray(0, lastIndex));

          const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
          const finalBytes = new Uint8Array(totalLength);
          let offset = 0;
          for (const part of parts) {
            finalBytes.set(part, offset);
            offset += part.length;
          }
          modifiedResponseText = new TextDecoder().decode(finalBytes);
        }

        if (sourceListFormatted.length > 0) {
          modifiedResponseText +=
            '\n\nSources:\n' + sourceListFormatted.join('\n');
        }
      }

      return {
        llmContent:
          `Web search results for "${this.params.query}":\n\n${modifiedResponseText}` +
          WEB_SEARCH_CHAIN_HINT,
        returnDisplay: `Search results for "${this.params.query}" returned.`,
        sources,
      };
    } catch (error: unknown) {
      if (isAbortError(error)) {
        throw error;
      }
      debugLogger.warn(
        `Gemini Google Search failed, falling back to independent web search: ${getErrorMessage(error)}`,
      );
      return null;
    }
  }

  private resolveActiveModelId(): string | undefined {
    const ctx = this.context;
    try {
      if (ctx && typeof ctx === 'object' && 'getModel' in ctx) {
        const getModel = ctx.getModel;
        if (typeof getModel === 'function') {
          return getModel.call(ctx);
        }
      }
      if (ctx && typeof ctx === 'object' && 'config' in ctx) {
        const cfg = (ctx as AgentLoopContext).config;
        if (cfg && typeof cfg.getModel === 'function') {
          return cfg.getModel();
        }
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  async execute({
    abortSignal: signal,
  }: ExecuteOptions): Promise<WebSearchToolResult> {
    try {
      const modelId = this.resolveActiveModelId();
      const preferred = process.env['WEB_SEARCH_PROVIDER']?.trim() || undefined;
      const plan = planWebSearchRoute({
        modelId,
        preferredProviderId: preferred,
      });

      const toToolResult = (http: {
        summary: string;
        provider: string;
        hits: Array<{ title: string; url: string }>;
      }): WebSearchToolResult => {
        const body = http.summary.startsWith('Web search results')
          ? http.summary
          : `Web search results for "${this.params.query}" (via ${http.provider}):\n\n${http.summary}`;
        return {
          llmContent: body + WEB_SEARCH_CHAIN_HINT,
          returnDisplay: `Search results for "${this.params.query}" returned (${http.provider}).`,
          sources: http.hits.map((h) => ({
            web: { title: h.title, uri: h.url },
          })),
        };
      };

      // Prefer explicit HTTP backends (Brave/Tavily/…) when the plan selects them
      // and they are available — so OSS models with BRAVE_API_KEY don't always hit Gemini.
      const preferHttp =
        plan.providerId &&
        plan.providerId !== 'gemini' &&
        plan.providerId !== 'duckduckgo';

      if (preferHttp) {
        try {
          const http = await executeWebSearchHttp({
            query: this.params.query,
            modelId,
            preferredProviderId: plan.providerId,
            signal,
            skipProviderIds: ['gemini'],
          });
          return toToolResult(http);
        } catch (httpErr) {
          debugLogger.warn(
            `HTTP web search failed (${plan.providerId}), trying Gemini/DDG: ${getErrorMessage(httpErr)}`,
          );
        }
      }

      // Gemini Google Search grounding (recommended for Gemini models / when client works)
      if (plan.providerId === 'gemini' || hasGeminiSearchKey() || !preferHttp) {
        const geminiResult = await this.executeGeminiSearch(signal);
        if (geminiResult) {
          return geminiResult;
        }
      }

      // Full multi-provider HTTP chain ending in DuckDuckGo
      const http = await executeWebSearchHttp({
        query: this.params.query,
        modelId,
        preferredProviderId: preferred,
        signal,
        skipProviderIds: ['gemini'],
      });
      return toToolResult(http);
    } catch (error: unknown) {
      if (isAbortError(error)) {
        return {
          llmContent: 'Web search was cancelled.',
          returnDisplay: 'Search cancelled.',
        };
      }
      const errorMessage = `Error during web search for query "${
        this.params.query
      }": ${getErrorMessage(error)}`;
      debugLogger.warn(errorMessage, error);
      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: `Error performing web search.`,
        error: {
          message: errorMessage,
          type: ToolErrorType.WEB_SEARCH_FAILED,
        },
      };
    }
  }
}

/**
 * A tool to perform web searches across multiple backends (Brave, Tavily,
 * Serper, Exa, Gemini Google Search, DuckDuckGo). Routing prefers the
 * recommended provider for the active model when a key is present.
 */
export class WebSearchTool extends BaseDeclarativeTool<
  WebSearchToolParams,
  WebSearchToolResult
> {
  static readonly Name = WEB_SEARCH_TOOL_NAME;

  constructor(
    private readonly context: AgentLoopContext | Config,
    messageBus: MessageBus,
  ) {
    super(
      WebSearchTool.Name,
      WEB_SEARCH_DISPLAY_NAME,
      WEB_SEARCH_DEFINITION.base.description!,
      Kind.Search,
      WEB_SEARCH_DEFINITION.base.parametersJsonSchema,
      messageBus,
      true, // isOutputMarkdown
      false, // canUpdateOutput
    );
  }

  /**
   * Validates the parameters for the WebSearchTool.
   * @param params The parameters to validate
   * @returns An error message string if validation fails, null if valid
   */
  protected override validateToolParamValues(
    params: WebSearchToolParams,
  ): string | null {
    if (!params.query || params.query.trim() === '') {
      return 'The \'query\' parameter cannot be empty. Example: {"query":"your search terms"}';
    }
    return null;
  }

  protected createInvocation(
    params: WebSearchToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<WebSearchToolParams, WebSearchToolResult> {
    // IMPORTANT: pass the registered context (Config) directly.
    // Previously this passed `this.context.config`, which is undefined when
    // the tool is constructed with a bare Config — breaking Gemini search.
    return new WebSearchToolInvocation(
      this.context,
      params,
      messageBus ?? this.messageBus,
      _toolName,
      _toolDisplayName,
    );
  }

  override getSchema(modelId?: string) {
    return resolveToolDeclaration(WEB_SEARCH_DEFINITION, modelId);
  }
}
