/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-request model routing. The session's base ContentGenerator is built
 * once for the auth method chosen at startup (Gemini API key, OAuth, ...),
 * so switching to a non-Google model mid-session (/model) used to send the
 * new model name to the Google endpoint and fail with "model not found".
 *
 * This wrapper checks the model of every request: models that resolve
 * through the multi-provider registry (configs/models.toml or provider/
 * prefixed ids) are dispatched to a lazily created, cached OpenAI-compatible
 * generator; everything else goes to the base generator unchanged.
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
import {
  createMultiProviderGenerator,
  isMultiProviderModel,
} from './factory.js';

/** Minimal surface of Config used for routing (avoids an import cycle). */
export interface RoutingConfigLike {
  getModel(): string;
}

export class ModelRoutingContentGenerator implements ContentGenerator {
  private readonly cache = new Map<string, ContentGenerator>();

  constructor(
    private readonly base: ContentGenerator,
    private readonly gcConfig: RoutingConfigLike,
  ) {}

  get userTier() {
    return this.base.userTier;
  }
  get userTierName() {
    return this.base.userTierName;
  }
  get paidTier() {
    return this.base.paidTier;
  }

  /**
   * Pick the generator for this request. Prefer a multi-provider session
   * model (from /model) even when a sticky request still carries an old
   * Gemini model id — that was the main cause of "I switched to OpenRouter
   * but still get Gemini".
   */
  private route(requestModel?: unknown): ContentGenerator {
    const fromRequest =
      typeof requestModel === 'string' && requestModel.trim()
        ? requestModel.trim()
        : '';
    const sessionModel = (this.gcConfig.getModel() ?? '').trim();

    // Session multi-provider model wins over a stale request model.
    const candidates: string[] = [];
    if (sessionModel && isMultiProviderModel(sessionModel)) {
      candidates.push(sessionModel);
    }
    if (fromRequest && fromRequest !== sessionModel) {
      candidates.push(fromRequest);
    }
    if (sessionModel && !candidates.includes(sessionModel)) {
      candidates.push(sessionModel);
    }

    for (const model of candidates) {
      if (!isMultiProviderModel(model)) {
        continue;
      }
      let generator = this.cache.get(model);
      if (!generator) {
        // Throws with an actionable message when the provider key is missing.
        const multi = createMultiProviderGenerator(model);
        if (!multi) {
          continue;
        }
        generator = multi;
        this.cache.set(model, generator);
      }
      return generator;
    }

    return this.base;
  }

  generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
    role: LlmRole,
  ): Promise<GenerateContentResponse> {
    return this.route(request.model).generateContent(
      request,
      userPromptId,
      role,
    );
  }

  generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
    role: LlmRole,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    return this.route(request.model).generateContentStream(
      request,
      userPromptId,
      role,
    );
  }

  countTokens(request: CountTokensParameters): Promise<CountTokensResponse> {
    return this.route(request.model).countTokens(request);
  }

  embedContent(request: EmbedContentParameters): Promise<EmbedContentResponse> {
    return this.route(request.model).embedContent(request);
  }
}
