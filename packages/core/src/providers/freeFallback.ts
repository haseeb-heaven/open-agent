/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runtime free-model fallback chain. Wraps an OpenAI-compatible generator
 * and, when a request fails with a rate limit or free-router routing
 * error, retries down the curated free catalog (freeFallbackCandidates)
 * until a model answers or the chain is exhausted. Once a fallback model
 * succeeds it stays active for subsequent requests, so a session does not
 * keep re-probing a dead model.
 */

import type {
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';
import type { ContentGenerator } from '../core/contentGenerator.js';
import type { LlmRole } from '../telemetry/llmRole.js';
import { getProvider } from './providers.js';
import { OpenAICompatContentGenerator } from './openaiCompatGenerator.js';
import {
  type FreeLLMCatalog,
  type FreeFallbackFailure,
  FreeModelsExhaustedError,
  formatFreeModelsExhaustedMessage,
  freeFallbackCandidates,
  isFreeRoutingFailure,
  summarizeFreeFallbackError,
  type FallbackCandidate,
} from './freeCatalog.js';
import type { ModelRegistry } from './modelRegistry.js';
import { readCliEnvAlias } from '../utils/cliEnvAliases.js';

function generatorForCandidate(
  candidate: FallbackCandidate,
  env?: NodeJS.ProcessEnv,
): OpenAICompatContentGenerator | undefined {
  const provider = getProvider(candidate.provider);
  if (!provider) return undefined;
  return new OpenAICompatContentGenerator({
    modelId: candidate.model,
    provider,
    apiBase: candidate.apiBase,
    temperature: candidate.temperature,
    maxTokens: candidate.maxTokens,
    env,
  });
}

export class FreeFallbackContentGenerator implements ContentGenerator {
  private active: OpenAICompatContentGenerator;

  constructor(
    primary: OpenAICompatContentGenerator,
    private readonly env?: NodeJS.ProcessEnv,
    private readonly options: {
      registry?: ModelRegistry;
      catalog?: FreeLLMCatalog;
    } = {},
  ) {
    this.active = primary;
  }

  /** Full "provider/model" id of the generator currently answering. */
  get activeModelId(): string {
    return `${this.active.provider.id}/${this.active.model}`;
  }

  get model(): string {
    return this.active.model;
  }

  get apiBase(): string {
    return this.active.apiBase;
  }

  private async withFallback<T>(
    attempt: (generator: OpenAICompatContentGenerator) => Promise<T>,
  ): Promise<T> {
    try {
      return await attempt(this.active);
    } catch (primaryError) {
      if (!isFreeRoutingFailure(primaryError)) throw primaryError;
      const tried = [this.activeModelId];
      let lastError: unknown = primaryError;
      const failures: FreeFallbackFailure[] = [
        {
          model: this.activeModelId,
          message: summarizeFreeFallbackError(primaryError),
        },
      ];
      const candidates = freeFallbackCandidates(this.activeModelId, {
        env: this.env,
        registry: this.options.registry,
        catalog: this.options.catalog,
      });
      const fastMode = readCliEnvAlias('FAST_MODE', this.env) === '1';

      if (fastMode) {
        // Keep the latency budget bounded: one alternate request after the
        // primary is enough to recover from a stalled endpoint without
        // turning fast mode into another serial fallback chain.
        const fastCandidates = candidates.slice(0, 1);
        const attempts = fastCandidates.map((candidate) => {
          const generator = generatorForCandidate(candidate, this.env);
          if (!generator)
            return Promise.reject(new Error('unavailable fallback'));
          tried.push(candidate.model);
          return attempt(generator)
            .then((result) => {
              this.active = generator;
              return result;
            })
            .catch((candidateError) => {
              failures.push({
                model: candidate.model,
                message: summarizeFreeFallbackError(candidateError),
              });
              throw candidateError;
            });
        });

        if (attempts.length > 0) {
          try {
            return await Promise.any(attempts);
          } catch {
            // Fall through to the same consolidated error used by normal mode.
            lastError = failures.at(-1)?.message ?? lastError;
          }
        }
      } else {
        for (const candidate of candidates) {
          const generator = generatorForCandidate(candidate, this.env);
          if (!generator) continue;
          tried.push(candidate.model);
          try {
            const result = await attempt(generator);
            this.active = generator;
            return result;
          } catch (candidateError) {
            // Local servers that are down or further rate limits: move on.
            lastError = candidateError;
            failures.push({
              model: candidate.model,
              message: summarizeFreeFallbackError(candidateError),
            });
          }
        }
      }
      throw new FreeModelsExhaustedError(
        formatFreeModelsExhaustedMessage(tried, lastError, failures),
        tried,
        lastError,
        failures,
      );
    }
  }

  async generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
    role: LlmRole,
  ): Promise<GenerateContentResponse> {
    return this.withFallback((generator) =>
      generator.generateContent(request, userPromptId, role),
    );
  }

  async generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
    role: LlmRole,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    // The compat generator performs the HTTP request (where routing
    // failures surface) before returning the async generator, so
    // falling back here never drops already-yielded chunks.
    return this.withFallback((generator) =>
      generator.generateContentStream(request, userPromptId, role),
    );
  }

  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    return this.active.countTokens(request);
  }

  async embedContent(
    request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    return this.active.embedContent(request);
  }
}
