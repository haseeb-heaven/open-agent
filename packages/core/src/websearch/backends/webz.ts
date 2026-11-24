/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  asString,
  fetchJson,
  formatHitsSummary,
  isRecord,
} from '../httpJson.js';
import type {
  WebSearchBackend,
  WebSearchHit,
  WebSearchResult,
} from '../types.js';

const ENV = 'WEBZ_API_TOKEN';
const URL_ENV = 'WEBZ_NEWS_SEARCH_URL';
const ENDPOINT = 'https://api.webz.io/api/news/context';
const MAX_HITS = 8;
const COVERAGE_DAYS = 30;

/**
 * News Search covers the last 30 days. The API has no `days` field, so the
 * client sends `filters.published_from` instead.
 */
export function webzPublishedFrom(now = new Date()): string {
  const day = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  day.setUTCDate(day.getUTCDate() - COVERAGE_DAYS);
  return day.toISOString().slice(0, 10);
}

/**
 * Accept only an absolute https URL. Call this before the token is attached
 * to a request.
 */
export function resolveWebzEndpoint(raw: string): string {
  const url = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      'The Webz.io News Search endpoint must be an absolute https:// URL.',
    );
  }
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(
      'The Webz.io News Search endpoint must be an absolute https:// URL.',
    );
  }
  return url;
}

function endpointFromEnv(env: NodeJS.ProcessEnv): string {
  const override = env[URL_ENV]?.trim();
  return resolveWebzEndpoint(override || ENDPOINT);
}

function hitFromItem(item: unknown): WebSearchHit | undefined {
  if (!isRecord(item)) return undefined;
  const article = isRecord(item['article']) ? item['article'] : undefined;
  if (!article) return undefined;
  const title = asString(article['title']);
  const url = asString(article['url']);
  if (!title || !url) return undefined;
  const chunk = isRecord(item['chunk']) ? item['chunk'] : undefined;
  const snippet =
    (chunk ? asString(chunk['text']) : undefined) ||
    asString(article['summary']);
  return { title, url, snippet };
}

export const webzBackend: WebSearchBackend = {
  meta: {
    id: 'webz',
    displayName: 'Webz.io News Search',
    envKey: ENV,
    signupUrl: 'https://docs.webz.io/docs/webz/news-search-api',
    notes:
      'Global news from the last 30 days. Requires WEBZ_API_TOKEN. Optional WEBZ_NEWS_SEARCH_URL must be https.',
    freeNoKey: false,
    recommendedFor: ['open_source', 'openai', 'anthropic', 'unknown'],
  },
  isAvailable(env = process.env): boolean {
    return Boolean(env[ENV]?.trim());
  },
  async search(query, options): Promise<WebSearchResult> {
    const env = options?.env ?? process.env;
    const endpoint = endpointFromEnv(env);
    const key = env[ENV]?.trim();
    if (!key) throw new Error(`${ENV} is not set`);

    const raw = await fetchJson(endpoint, {
      method: 'POST',
      signal: options?.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        query,
        k: MAX_HITS,
        filters: { published_from: webzPublishedFrom() },
      }),
    });

    const hits: WebSearchHit[] = [];
    if (isRecord(raw) && Array.isArray(raw['results'])) {
      for (const item of raw['results']) {
        const hit = hitFromItem(item);
        if (!hit) continue;
        hits.push(hit);
        if (hits.length >= MAX_HITS) break;
      }
    }

    if (hits.length === 0) {
      throw new Error('Webz returned no results');
    }

    return {
      hits,
      provider: 'webz',
      summary: formatHitsSummary(query, hits, 'webz'),
    };
  },
};
