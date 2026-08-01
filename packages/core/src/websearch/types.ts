/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** One web hit returned to the agent. */
export interface WebSearchHit {
  title: string;
  url: string;
  snippet?: string;
}

/** Normalized search result from any backend. */
export interface WebSearchResult {
  summary: string;
  hits: WebSearchHit[];
  provider: string;
}

/** Model “family” used only for recommendation UI (not hard-coded topics). */
export type ModelFamilyHint =
  | 'gemini'
  | 'openai'
  | 'anthropic'
  | 'open_source'
  | 'local'
  | 'unknown';

export interface WebSearchProviderMeta {
  /** Stable id used in settings / CLI. */
  id: string;
  displayName: string;
  /** Env var for the API key; null = no key required. */
  envKey: string | null;
  /** Where users create a key (opened when textbox empty). */
  signupUrl: string | null;
  /** Short help for README / wizard. */
  notes: string;
  /** True when this backend needs no network key. */
  freeNoKey: boolean;
  /** True when a key is optional (works without, but a key upgrades limits). */
  keyOptional?: boolean;
  /**
   * Model families this backend is recommended for (UI badge only).
   * Auto-routing still prefers any available key first.
   */
  recommendedFor: ModelFamilyHint[];
}

export interface WebSearchBackend {
  meta: WebSearchProviderMeta;
  /** Whether env currently has what this backend needs. */
  isAvailable(env?: NodeJS.ProcessEnv): boolean;
  search(
    query: string,
    options?: { signal?: AbortSignal; env?: NodeJS.ProcessEnv },
  ): Promise<WebSearchResult>;
}

export interface WebSearchRouteDecision {
  /** Backend that will run (or null if none). */
  providerId: string | null;
  /** Why this one was picked. */
  reason: string;
  /** Ordered list for the wizard (recommended first for current model). */
  ranked: Array<{
    meta: WebSearchProviderMeta;
    available: boolean;
    recommended: boolean;
  }>;
}
