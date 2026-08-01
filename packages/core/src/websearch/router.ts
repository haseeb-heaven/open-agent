/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { inferModelFamily } from './modelFamily.js';
import { listWebSearchProviders, getWebSearchBackend } from './registry.js';
import type {
  ModelFamilyHint,
  WebSearchProviderMeta,
  WebSearchResult,
  WebSearchRouteDecision,
} from './types.js';

/**
 * Default auto-route order when no explicit provider is forced.
 * Gemini is special-cased in the tool (LLM client); HTTP backends follow this order.
 */
const DEFAULT_HTTP_ORDER = [
  'exa',
  'brave',
  'tavily',
  'serper',
  'duckduckgo',
] as const;

/**
 * Recommended backend id for a model family (UI + soft preference).
 */
export function recommendedWebSearchProviderId(
  family: ModelFamilyHint,
): string {
  switch (family) {
    case 'gemini':
      return 'gemini';
    case 'local':
      return 'duckduckgo';
    case 'openai':
    case 'anthropic':
    case 'open_source':
    case 'unknown':
    default:
      return 'exa';
  }
}

export function rankWebSearchProviders(options: {
  modelId?: string | null;
  env?: NodeJS.ProcessEnv;
  preferredProviderId?: string | null;
}): WebSearchRouteDecision['ranked'] {
  const env = options.env ?? process.env;
  const family = inferModelFamily(options.modelId);
  const recommendedId = recommendedWebSearchProviderId(family);
  const preferred = options.preferredProviderId?.trim().toLowerCase() || null;

  const backends = listWebSearchProviders();
  const scored = backends.map((b) => {
    const available = b.isAvailable(env);
    const recommended = b.meta.id === recommendedId;
    let score = 0;
    if (preferred && b.meta.id === preferred) score += 1000;
    if (recommended) score += 100;
    if (available) score += 50;
    if (b.meta.freeNoKey) score += 5;
    // Stable order among equals
    const orderIdx = (DEFAULT_HTTP_ORDER as readonly string[]).indexOf(
      b.meta.id,
    );
    score += orderIdx >= 0 ? Math.max(0, 10 - orderIdx) : 0;
    return { meta: b.meta, available, recommended, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map(({ meta, available, recommended }) => ({
    meta,
    available,
    recommended,
  }));
}

export function planWebSearchRoute(options: {
  modelId?: string | null;
  env?: NodeJS.ProcessEnv;
  /** Explicit force: settings or WEB_SEARCH_PROVIDER env. */
  preferredProviderId?: string | null;
}): WebSearchRouteDecision {
  const env = options.env ?? process.env;
  const preferred =
    options.preferredProviderId?.trim() ||
    env['WEB_SEARCH_PROVIDER']?.trim() ||
    null;
  const ranked = rankWebSearchProviders({
    modelId: options.modelId,
    env,
    preferredProviderId: preferred,
  });

  const family = inferModelFamily(options.modelId);
  const recommendedId = recommendedWebSearchProviderId(family);

  // Explicit preference if available
  if (preferred) {
    const hit = ranked.find((r) => r.meta.id === preferred);
    if (hit?.available) {
      return {
        providerId: preferred,
        reason: `Using preferred web search provider "${preferred}".`,
        ranked,
      };
    }
  }

  // Recommended for this model if key present
  const rec = ranked.find((r) => r.meta.id === recommendedId && r.available);
  if (rec) {
    return {
      providerId: rec.meta.id,
      reason: `Recommended for current model family (${family}): ${rec.meta.displayName}.`,
      ranked,
    };
  }

  // First available paid/key backend in default order
  for (const id of DEFAULT_HTTP_ORDER) {
    const hit = ranked.find((r) => r.meta.id === id && r.available);
    if (hit) {
      return {
        providerId: hit.meta.id,
        reason: `Using available web search provider: ${hit.meta.displayName}.`,
        ranked,
      };
    }
  }

  // Gemini availability is key-only here; actual search is client-side
  const gem = ranked.find((r) => r.meta.id === 'gemini' && r.available);
  if (gem) {
    return {
      providerId: 'gemini',
      reason: 'Using Google Search via Gemini API key.',
      ranked,
    };
  }

  // DuckDuckGo always available
  return {
    providerId: 'duckduckgo',
    reason: 'No search API keys set — using DuckDuckGo (no key).',
    ranked,
  };
}

/**
 * Run HTTP web search backends (not Gemini client grounding).
 * Tries preferred/recommended chain until one succeeds.
 */
export async function executeWebSearchHttp(options: {
  query: string;
  modelId?: string | null;
  env?: NodeJS.ProcessEnv;
  preferredProviderId?: string | null;
  signal?: AbortSignal;
  /** Skip gemini placeholder backend. */
  skipProviderIds?: string[];
}): Promise<WebSearchResult> {
  const env = options.env ?? process.env;
  const plan = planWebSearchRoute({
    modelId: options.modelId,
    env,
    preferredProviderId: options.preferredProviderId,
  });

  const skip = new Set(options.skipProviderIds ?? ['gemini']);
  const tryOrder: string[] = [];
  if (plan.providerId && !skip.has(plan.providerId)) {
    tryOrder.push(plan.providerId);
  }
  for (const row of plan.ranked) {
    if (skip.has(row.meta.id)) continue;
    if (!row.available) continue;
    if (!tryOrder.includes(row.meta.id)) tryOrder.push(row.meta.id);
  }
  // Always end with duckduckgo
  if (!tryOrder.includes('duckduckgo')) tryOrder.push('duckduckgo');

  const errors: string[] = [];
  for (const id of tryOrder) {
    const backend = getWebSearchBackend(id);
    if (!backend || !backend.isAvailable(env)) continue;
    try {
      return await backend.search(options.query, {
        signal: options.signal,
        env,
      });
    } catch (e) {
      errors.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  throw new Error(
    `All web search backends failed: ${errors.join(' | ') || 'none available'}`,
  );
}

/**
 * Human-readable key status for a provider (used by CLI help + wizard).
 * Honors freeNoKey / keyOptional so keyless providers don't show "✗ no key".
 */
export function keyStatusLabel(
  meta: WebSearchProviderMeta,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!meta.envKey) return 'no key needed';
  const hasKey = Boolean(env[meta.envKey]?.trim());
  if (meta.freeNoKey || meta.keyOptional) {
    return hasKey ? '✓ key set (optional)' : 'no key needed';
  }
  return hasKey ? '✓ key set' : '✗ no key';
}

export function webSearchProviderHelpTable(
  env: NodeJS.ProcessEnv = process.env,
  modelId?: string | null,
): string {
  const ranked = rankWebSearchProviders({ modelId, env });
  const lines = [
    'Web search providers:',
    '',
    '  /websearch              list providers + recommended for current model',
    '  /websearch <id>         show details + key status',
    '  /websearch <id> <key>   save API key to .env',
    '  /websearch open <id>    open signup page in browser (get an API key)',
    '',
  ];
  for (const row of ranked) {
    const key = keyStatusLabel(row.meta, env);
    const rec = row.recommended ? ' ★ recommended' : '';
    lines.push(
      `  ${row.meta.id.padEnd(12)} ${(row.meta.envKey ?? '—').padEnd(18)} ${key}${rec}`,
    );
    lines.push(`               ${row.meta.notes}`);
  }
  lines.push('');
  lines.push(
    'Set WEB_SEARCH_PROVIDER=<id> to force a backend. Empty key textbox: use /websearch open <id>.',
  );
  return lines.join('\n');
}

export type { WebSearchProviderMeta };
