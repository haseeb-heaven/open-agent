1. **Add `JevClassifierStrategy` implementation**
   - Use `write_file` to create `packages/core/src/routing/strategies/jevClassifierStrategy.ts` with the exact code block:
   ```typescript
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { TypeSafeClient, choice } from '@typesafe-ai/sdk';
import type { Config } from '../../config/config.js';
import type { BaseLlmClient } from '../../core/baseLlmClient.js';
import type {
  RoutingContext,
  RoutingDecision,
  RoutingStrategy,
} from '../routingStrategy.js';
import {
  resolveClassifierModel,
  isGemini3Model,
  isAutoModel,
} from '../../config/models.js';
import {
  isFunctionCall,
  isFunctionResponse,
} from '../../utils/messageInspectors.js';
import { debugLogger } from '../../utils/debugLogger.js';
import { normalizeModelId } from '../../utils/modelUtils.js';
import type { LocalLiteRtLmClient } from '../../core/localLiteRtLmClient.js';
import { createUserContent } from '@google/genai';

const HISTORY_TURNS_FOR_CONTEXT = 4;
const HISTORY_SEARCH_WINDOW = 20;

export class JevClassifierStrategy implements RoutingStrategy {
  readonly name = 'jev-classifier';
  private client: TypeSafeClient | null = null;
  private minConfidence = 0.7; // Minimum confidence to accept the classification
  private fallbackConfidence = 0.45; // Below this, fall back to next router. Between this and minConfidence, prefer stronger model.

  private getClient(apiKey: string): TypeSafeClient {
    if (!this.client) {
      this.client = new TypeSafeClient({ apiKey });
    }
    return this.client;
  }

  async route(
    context: RoutingContext,
    config: Config,
    _baseLlmClient: BaseLlmClient,
    _localLiteRtLmClient: LocalLiteRtLmClient,
  ): Promise<RoutingDecision | null> {
    const startTime = Date.now();
    try {
      // 1. Check if Jev routing should run
      const apiKey = process.env['JEV_API_KEY'];
      if (!apiKey) {
        return null;
      }

      const model = context.requestedModel ?? config.getModel();

      // If the user explicitly requested a specific model (not auto), bypass Jev
      if (!isAutoModel(model, config)) {
        return null;
      }

      if (
        (await config.getNumericalRoutingEnabled()) &&
        isGemini3Model(model, config)
      ) {
        return null;
      }

      if (isFunctionResponse(createUserContent(context.request))) {
        debugLogger.log(
          '[Routing] Bypassing Jev Classifier: request is FunctionResponse.',
        );
        return null;
      }

      const historySlice = context.history.slice(-HISTORY_SEARCH_WINDOW);
      const cleanHistory = historySlice.filter(
        (content) => !isFunctionCall(content) && !isFunctionResponse(content),
      );
      const finalHistory = cleanHistory.slice(-HISTORY_TURNS_FOR_CONTEXT);

      const requestText =
        context.request && Array.isArray(context.request)
          ? context.request
              .map((p) => (typeof p === 'string' ? p : p.text || ''))
              .join('')
          : typeof context.request === 'string'
            ? context.request
            : JSON.stringify(context.request);

      const state = {
        request: requestText,
        recentConversation: finalHistory,
        context: {
          hasToolHistory: context.history.some(isFunctionCall),
          conversationLength: context.history.length,
          requestLength: requestText.length,
        },
      };

      const questions = {
        complexity: choice(
          'What level of model capability does this software-engineering task require?',
          {
            simple: {
              description:
                'Specific, bounded, low-risk task requiring little reasoning and usually 1-2 straightforward operations.',
              examples: [
                'read a file',
                'rename a variable',
                'explain a small function',
                'perform a simple lookup',
              ],
            },
            standard: {
              description:
                'Normal software-engineering task requiring some reasoning or several straightforward operations.',
              examples: [
                'implement a small isolated feature',
                'modify a few related files',
                'write ordinary tests',
                'investigate a well-scoped issue',
              ],
            },
            complex: {
              description:
                'Multi-step engineering, debugging, architecture, investigation, or coordinated repository changes.',
              examples: [
                'trace a difficult bug',
                'design a subsystem',
                'perform a multi-file refactor',
                'investigate interactions between components',
              ],
            },
            expert: {
              description:
                'Very difficult task requiring deep reasoning, broad investigation, significant uncertainty, or long-horizon planning.',
              examples: [
                'reverse engineering',
                'large architectural redesign',
                'complex security analysis',
                'deep root-cause analysis',
                'large autonomous coding task',
              ],
            },
          },
        ),
      };

      const client = this.getClient(apiKey);
      const response = await client.systemOne({
        state,
        questions,
      });

      const decision = response.complexity;
      if (!decision || typeof decision.confidence !== 'number') {
        debugLogger.warn('[Routing] Malformed Jev response.');
        return null;
      }

      const complexity = decision.value;
      const confidence = decision.confidence;

      let targetTier: 'flash' | 'pro' | null = null;
      let finalReasoning = '';

      if (confidence >= this.minConfidence) {
        // High confidence - direct mapping
        targetTier =
          complexity === 'simple' || complexity === 'standard'
            ? 'flash'
            : 'pro';
        finalReasoning = `Jev classified task as ${complexity} with confidence ${confidence.toFixed(2)}.`;
      } else if (confidence >= this.fallbackConfidence) {
        // Medium confidence - prefer pro for safety if it was standard/complex/expert
        // Even if it thought simple, if confidence isn't great, better use pro? Let's just map to pro for safety.
        targetTier = 'pro';
        finalReasoning = `Jev classified task as ${complexity} with medium confidence ${confidence.toFixed(2)}, preferring stronger tier for safety.`;
      } else {
        // Low confidence - bypass
        debugLogger.warn(
          `[Routing] Jev confidence too low (${confidence.toFixed(2)}). Bypassing.`,
        );
        return null;
      }

      const latencyMs = Date.now() - startTime;
      const [useGemini3_1, useCustomToolModel] = await Promise.all([
        config.getGemini31Launched(),
        config.getUseCustomToolModel(),
      ]);
      const useGemini3_5Flash = config.hasGemini35FlashGAAccess?.() ?? false;
      const selectedModel = normalizeModelId(
        resolveClassifierModel(
          normalizeModelId(model),
          targetTier,
          useGemini3_1,
          useCustomToolModel,
          config.getHasAccessToPreviewModel?.() ?? true,
          config,
          useGemini3_5Flash,
        ),
      );

      const service = config.getModelAvailabilityService();
      const snapshot = service.snapshot(selectedModel);

      if (!snapshot.available) {
        debugLogger.warn(
          `[Routing] Jev Classifier selected unavailable model ${selectedModel} (${snapshot.reason}). Bypassing.`,
        );
        return null;
      }

      return {
        model: selectedModel,
        metadata: {
          source: 'Jev',
          latencyMs,
          reasoning: finalReasoning,
        },
      };
    } catch (error) {
      debugLogger.warn(`[Routing] JevClassifierStrategy failed:`, error);
      return null;
    }
  }
}
   ```
2. **Add Unit Tests for `JevClassifierStrategy`**
   - Use `write_file` to create `packages/core/src/routing/strategies/jevClassifierStrategy.test.ts` with the exact code block:
   ```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JevClassifierStrategy } from './jevClassifierStrategy.js';
import type { Config } from '../../config/config.js';
import type { BaseLlmClient } from '../../core/baseLlmClient.js';
import type { RoutingContext } from '../routingStrategy.js';
import type { LocalLiteRtLmClient } from '../../core/localLiteRtLmClient.js';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { resolveClassifierModel, isAutoModel } from '../../config/models.js';

vi.mock('@typesafe-ai/sdk', () => {
  return {
    TypeSafeClient: vi.fn().mockImplementation(() => {
      return {
        systemOne: vi.fn(),
      };
    }),
    choice: vi.fn((prompt, options) => options),
  };
});

vi.mock('../../config/models.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/models.js')>();
  return {
    ...actual,
    resolveClassifierModel: vi.fn().mockReturnValue('resolved-model-123'),
    isAutoModel: vi.fn().mockReturnValue(true),
    isGemini3Model: vi.fn().mockReturnValue(false),
  };
});

vi.mock('../../utils/modelUtils.js', () => ({
  normalizeModelId: vi.fn((m) => m),
}));

describe('JevClassifierStrategy', () => {
  let strategy: JevClassifierStrategy;
  let mockConfig: Partial<Config>;
  let mockContext: Partial<RoutingContext>;
  let mockClient: Partial<BaseLlmClient>;
  let mockLocalClient: Partial<LocalLiteRtLmClient>;

  beforeEach(() => {
    process.env['JEV_API_KEY'] = 'test-key';
    strategy = new JevClassifierStrategy();

    mockConfig = {
      getModel: vi.fn().mockReturnValue('auto'),
      getNumericalRoutingEnabled: vi.fn().mockResolvedValue(false),
      getGemini31Launched: vi.fn().mockResolvedValue(false),
      getUseCustomToolModel: vi.fn().mockResolvedValue(false),
      getHasAccessToPreviewModel: vi.fn().mockReturnValue(true),
      hasGemini35FlashGAAccess: vi.fn().mockReturnValue(false),
      getModelAvailabilityService: vi.fn().mockReturnValue({
        snapshot: vi.fn().mockReturnValue({ available: true }),
      }),
    };

    mockContext = {
      requestedModel: undefined,
      history: [],
      request: [{ text: 'test request' }],
      signal: new AbortController().signal,
    };
  });

  afterEach(() => {
    delete process.env['JEV_API_KEY'];
    vi.clearAllMocks();
  });

  it('should return null if JEV_API_KEY is missing', async () => {
    delete process.env['JEV_API_KEY'];
    const result = await strategy.route(
      mockContext as RoutingContext,
      mockConfig as Config,
      mockClient as BaseLlmClient,
      mockLocalClient as LocalLiteRtLmClient,
    );
    expect(result).toBeNull();
  });

  it('should return null if not using auto model', async () => {
    vi.mocked(isAutoModel).mockReturnValueOnce(false);
    mockContext.requestedModel = 'gemini-1.5-pro';
    const result = await strategy.route(
      mockContext as RoutingContext,
      mockConfig as Config,
      mockClient as BaseLlmClient,
      mockLocalClient as LocalLiteRtLmClient,
    );
    expect(result).toBeNull();
  });

  it('should return a model for a highly confident complex task', async () => {
    const mockSystemOne = vi.fn().mockResolvedValue({
      complexity: { value: 'complex', confidence: 0.9 },
    });
    vi.mocked(TypeSafeClient).mockImplementationOnce(() => ({
      systemOne: mockSystemOne,
    } as any));

    const result = await strategy.route(
      mockContext as RoutingContext,
      mockConfig as Config,
      mockClient as BaseLlmClient,
      mockLocalClient as LocalLiteRtLmClient,
    );

    expect(result).not.toBeNull();
    expect(result?.model).toBe('resolved-model-123');
    expect(resolveClassifierModel).toHaveBeenCalledWith(
      'auto',
      'pro',
      false,
      false,
      true,
      mockConfig,
      false,
    );
    expect(result?.metadata.source).toBe('Jev');
    expect(result?.metadata.reasoning).toContain('complex');
    expect(result?.metadata.reasoning).toContain('0.9');
  });

  it('should return a model for a highly confident simple task', async () => {
    const mockSystemOne = vi.fn().mockResolvedValue({
      complexity: { value: 'simple', confidence: 0.85 },
    });
    vi.mocked(TypeSafeClient).mockImplementationOnce(() => ({
      systemOne: mockSystemOne,
    } as any));

    const result = await strategy.route(
      mockContext as RoutingContext,
      mockConfig as Config,
      mockClient as BaseLlmClient,
      mockLocalClient as LocalLiteRtLmClient,
    );

    expect(result).not.toBeNull();
    expect(resolveClassifierModel).toHaveBeenCalledWith(
      'auto',
      'flash',
      false,
      false,
      true,
      mockConfig,
      false,
    );
  });

  it('should fallback to pro model if confidence is medium', async () => {
    const mockSystemOne = vi.fn().mockResolvedValue({
      complexity: { value: 'simple', confidence: 0.5 },
    });
    vi.mocked(TypeSafeClient).mockImplementationOnce(() => ({
      systemOne: mockSystemOne,
    } as any));

    const result = await strategy.route(
      mockContext as RoutingContext,
      mockConfig as Config,
      mockClient as BaseLlmClient,
      mockLocalClient as LocalLiteRtLmClient,
    );

    expect(result).not.toBeNull();
    expect(resolveClassifierModel).toHaveBeenCalledWith(
      'auto',
      'pro',
      false,
      false,
      true,
      mockConfig,
      false,
    );
    expect(result?.metadata.reasoning).toContain('preferring stronger tier');
  });

  it('should return null if confidence is too low', async () => {
    const mockSystemOne = vi.fn().mockResolvedValue({
      complexity: { value: 'simple', confidence: 0.2 },
    });
    vi.mocked(TypeSafeClient).mockImplementationOnce(() => ({
      systemOne: mockSystemOne,
    } as any));

    const result = await strategy.route(
      mockContext as RoutingContext,
      mockConfig as Config,
      mockClient as BaseLlmClient,
      mockLocalClient as LocalLiteRtLmClient,
    );

    expect(result).toBeNull();
  });

  it('should return null if API fails', async () => {
    const mockSystemOne = vi.fn().mockRejectedValue(new Error('Network error'));
    vi.mocked(TypeSafeClient).mockImplementationOnce(() => ({
      systemOne: mockSystemOne,
    } as any));

    const result = await strategy.route(
      mockContext as RoutingContext,
      mockConfig as Config,
      mockClient as BaseLlmClient,
      mockLocalClient as LocalLiteRtLmClient,
    );

    expect(result).toBeNull();
  });
});
   ```
3. **Verify JevClassifierStrategy file**
   - Use `read_file` on `packages/core/src/routing/strategies/jevClassifierStrategy.ts` to confirm correct code was written.
4. **Verify JevClassifierStrategy test file**
   - Use `read_file` on `packages/core/src/routing/strategies/jevClassifierStrategy.test.ts` to confirm correct test code was written.
5. **Update `ModelRouterService` import**
   - Use `replace_with_git_merge_diff` on `packages/core/src/routing/modelRouterService.ts` at line 16.
   ```
<<<<<<< SEARCH
import { ClassifierStrategy } from './strategies/classifierStrategy.js';
=======
import { ClassifierStrategy } from './strategies/classifierStrategy.js';
import { JevClassifierStrategy } from './strategies/jevClassifierStrategy.js';
>>>>>>> REPLACE
   ```
6. **Update `ModelRouterService` strategy list**
   - Use `replace_with_git_merge_diff` on `packages/core/src/routing/modelRouterService.ts` at line 54.
   ```
<<<<<<< SEARCH
    // The generic classifier is next.
    strategies.push(new ClassifierStrategy());
=======
    // Jev classifier strategy is next, if configured.
    strategies.push(new JevClassifierStrategy());

    // The generic classifier is next.
    strategies.push(new ClassifierStrategy());
>>>>>>> REPLACE
   ```
7. **Verify ModelRouterService Update**
   - Use `read_file` on `packages/core/src/routing/modelRouterService.ts` to verify the strategy was properly inserted.
8. **Update `.env.example`**
   - Use `replace_with_git_merge_diff` on `.env.example` at line 35.
   ```
<<<<<<< SEARCH
# GEMINI_API_KEY already listed above — also enables Google Search grounding
WEB_SEARCH_PROVIDER=
=======
# GEMINI_API_KEY already listed above — also enables Google Search grounding
WEB_SEARCH_PROVIDER=

# -----------------------------------------------------------------------------
# TypeSafe AI / Jev
# Optional. Enables Jev-powered automatic model routing.
# Get an API key from:
# https://console.typesafe.ai
# -----------------------------------------------------------------------------
JEV_API_KEY=
>>>>>>> REPLACE
   ```
9. **Verify `.env.example` Update**
   - Use `read_file` on `.env.example` to ensure `JEV_API_KEY` is documented.
10. **Update README.md**
    - Use `replace_with_git_merge_diff` on `README.md` at line 122.
    ```
<<<<<<< SEARCH
| `-y, --yolo`      | Auto-approve tools (trusted workspaces only)                     |

## Extensions & marketplace
=======
| `-y, --yolo`      | Auto-approve tools (trusted workspaces only)                     |

### Jev automatic routing

When `JEV_API_KEY` is configured and automatic model selection is enabled, Open Agent can use TypeSafe AI's Jev System One model to classify task complexity before selecting the execution model.
Jev does not replace the execution model, it just routes to the appropriate one.
If the user explicitly selected a model using the existing model-selection mechanism, Jev is bypassed.
See [TypeSafe documentation](https://docs.typesafe.ai/sdk) for more details.

## Extensions & marketplace
>>>>>>> REPLACE
    ```
11. **Verify README.md Update**
    - Use `read_file` on `README.md` to ensure the documentation is added correctly.
12. **Clean up scratchpads/temp files**
    - Use `run_in_bash_session` to `rm plan.md`.
13. **Run Tests**
    - Use `run_in_bash_session` with `npm run test --workspace=packages/core` to run the tests.
14. **Run Linter**
    - Use `run_in_bash_session` with `npm run lint` and `npm run typecheck`.
15. **Complete pre-commit steps**
    - Complete pre-commit steps to ensure proper testing, verification, review, and reflection are done.
16. **Submit changes**
    - Use `request_plan_review` to present the final PR submission with title `feat: Add Jev automatic task-complexity routing` and description `This PR integrates TypeSafe AI's Jev System One model into Open Agent to serve as a fast, structured classifier for task complexity...`.
