/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { choice, TypeSafeClient } from '@typesafe-ai/sdk';
import type { BaseLlmClient } from '../../core/baseLlmClient.js';
import type {
  RoutingContext,
  RoutingDecision,
  RoutingStrategy,
} from '../routingStrategy.js';
import { resolveClassifierModel } from '../../config/models.js';
import { createUserContent, type Content, type Part } from '@google/genai';
import type { Config } from '../../config/config.js';
import {
  isFunctionCall,
  isFunctionResponse,
} from '../../utils/messageInspectors.js';
import { debugLogger } from '../../utils/debugLogger.js';
import { normalizeModelId } from '../../utils/modelUtils.js';
import type { LocalLiteRtLmClient } from '../../core/localLiteRtLmClient.js';

// The number of recent history turns to provide to the router for context.
const HISTORY_TURNS_FOR_CONTEXT = 4;
const HISTORY_SEARCH_WINDOW = 20;

const FLASH_MODEL = 'flash';
const PRO_MODEL = 'pro';

/**
 * The environment variable that enables the Jev classifier. When unset, the
 * strategy is never registered and routing falls through to the generic
 * LLM-based classifiers.
 */
export const JEV_API_KEY_ENV_VAR = 'JEV_API_KEY';

/**
 * The minimum confidence (0-1) that the Jev System One model must report in
 * its complexity choice before it is trusted. Below this threshold the
 * strategy declines and the standard LLM classifier chain runs instead.
 */
const JEV_CONFIDENCE_THRESHOLD = 0.6;

/**
 * Per-request timeout (ms) for the Jev classification call. Routing sits on
 * the critical path of every turn, so the classifier must fail fast.
 */
const JEV_REQUEST_TIMEOUT_MS = 10_000;

const COMPLEXITY_CRITERIA = {
  simple:
    'A highly specific, bounded task with low operational complexity (estimated 1-3 tool calls), e.g. reading a file or renaming a variable.',
  standard:
    'A moderately scoped task with a few dependent steps that is still well-defined and unambiguous.',
  complex:
    'A multi-step task with high operational complexity (estimated 4+ tool calls), extensive investigation, or deep debugging and root cause analysis.',
  expert:
    'An open-ended, strategic, or architectural task requiring high-level design, planning, or conceptual reasoning.',
} as const;

type JevComplexity = keyof typeof COMPLEXITY_CRITERIA;

const COMPLEXITY_QUESTION =
  'Analyze the chat history and the current user request, then classify the complexity of the task.';

/**
 * Maps a Jev complexity choice to a flash/pro model alias.
 */
function complexityToModelAlias(complexity: JevComplexity): string {
  switch (complexity) {
    case 'simple':
    case 'standard':
      return FLASH_MODEL;
    case 'complex':
    case 'expert':
      return PRO_MODEL;
  }
}

/**
 * A routing strategy that delegates task-complexity classification to
 * TypeSafe AI's Jev System One model. Jev provides a fast, deterministic
 * decision engine for routing, which avoids spending reasoning tokens from
 * the primary execution models on classification.
 *
 * The strategy is only applicable when the `JEV_API_KEY` environment variable
 * is set. If Jev declines (low confidence), fails, or the request is not
 * classifiable (e.g. a tool function response), the strategy returns `null`
 * so the composite router falls through to the generic LLM classifiers.
 */
export class JevClassifierStrategy implements RoutingStrategy {
  readonly name = 'jev-classifier';

  /**
   * Builds the textual state evaluated by Jev from the recent, tool-free
   * portion of the chat history plus the current request.
   */
  private buildState(turns: Content[]): string {
    const formattedHistory = turns
      .slice(0, -1)
      .map((turn) =>
        turn.parts
          ? turn.parts
              .map((part) => part.text)
              .filter(Boolean)
              .join('\n')
          : '',
      )
      .filter(Boolean)
      .join('\n\n');

    const lastTurn = turns.at(-1);
    const userRequest =
      lastTurn?.parts
        ?.map((part: Part) => part.text)
        .filter(Boolean)
        .join('\n\n') ?? '';

    return formattedHistory
      ? `Chat History:\n${formattedHistory}\n\nCurrent Request:\n${userRequest}`
      : `Current Request:\n${userRequest}`;
  }

  async route(
    context: RoutingContext,
    config: Config,
    _baseLlmClient: BaseLlmClient,
    _localLiteRtLmClient: LocalLiteRtLmClient,
  ): Promise<RoutingDecision | null> {
    const apiKey = process.env[JEV_API_KEY_ENV_VAR];
    if (!apiKey) {
      return null;
    }

    const startTime = Date.now();
    try {
      // Bypass the classifier if the request is a function response. Tool
      // turns are pruned from history, so there is no meaningful request to
      // classify and the payload would be invalid on its own.
      if (isFunctionResponse(createUserContent(context.request))) {
        debugLogger.log(
          '[Routing] Bypassing JevClassifier: request is FunctionResponse.',
        );
        return null;
      }

      const historySlice = context.history.slice(-HISTORY_SEARCH_WINDOW);

      // Filter out tool-related turns.
      const cleanHistory = historySlice.filter(
        (content) => !isFunctionCall(content) && !isFunctionResponse(content),
      );

      // Take the last N turns from the *cleaned* history.
      const finalHistory = cleanHistory.slice(-HISTORY_TURNS_FOR_CONTEXT);

      const state = this.buildState([
        ...finalHistory,
        createUserContent(context.request),
      ]);

      const client = new TypeSafeClient({
        apiKey,
        logLevel: 'warn',
        timeout: JEV_REQUEST_TIMEOUT_MS,
      });

      const response = await client.systemOne(
        {
          state,
          questions: {
            complexity: choice(COMPLEXITY_QUESTION, COMPLEXITY_CRITERIA),
          },
        },
        { signal: context.signal },
      );

      const answer = response.answers.complexity;
      const latencyMs = Date.now() - startTime;

      if (answer.confidence < JEV_CONFIDENCE_THRESHOLD) {
        debugLogger.debug(
          `[Routing] JevClassifier confidence ${answer.confidence.toFixed(2)} below threshold ${JEV_CONFIDENCE_THRESHOLD}; declining.`,
        );
        return null;
      }

      const modelAlias = complexityToModelAlias(answer.choice);
      const model = context.requestedModel ?? config.getModel();
      const [useGemini3_1, useCustomToolModel, hasAccessToPreview] =
        await Promise.all([
          config.getGemini31Launched(),
          config.getUseCustomToolModel(),
          config.getHasAccessToPreviewModel(),
        ]);
      const useGemini3_5Flash = config.hasGemini35FlashGAAccess?.() ?? false;

      const selectedModel = normalizeModelId(
        resolveClassifierModel(
          normalizeModelId(model),
          modelAlias,
          useGemini3_1,
          useCustomToolModel,
          hasAccessToPreview,
          config,
          useGemini3_5Flash,
        ),
      );

      const service = config.getModelAvailabilityService();
      const snapshot = service.snapshot(selectedModel);

      if (!snapshot.available) {
        debugLogger.warn(
          `[Routing] JevClassifier selected unavailable model ${selectedModel} (${snapshot.reason}). Bypassing.`,
        );
        return null;
      }

      return {
        model: selectedModel,
        metadata: {
          source: 'JevClassifier',
          latencyMs,
          reasoning: `Jev classified the task as '${answer.choice}' (confidence ${answer.confidence.toFixed(2)}), routing to the ${modelAlias} tier.`,
        },
      };
    } catch (error) {
      // If Jev fails for any reason (API error, abort, etc.), log it and
      // return null to allow the composite strategy to proceed.
      debugLogger.warn(`[Routing] JevClassifierStrategy failed:`, error);
      return null;
    }
  }
}
