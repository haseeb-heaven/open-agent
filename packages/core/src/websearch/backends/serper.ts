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

const ENV = 'SERPER_API_KEY';
const BASE_URL = 'https://google.serper.dev';

export const serperBackend: WebSearchBackend = {
  meta: {
    id: 'serper',
    displayName: 'Serper (Google SERP)',
    envKey: ENV,
    signupUrl: 'https://serper.dev/api-key',
    notes: 'Google-style SERP results via Serper. Cheap and fast.',
    freeNoKey: false,
    recommendedFor: ['open_source', 'openai', 'anthropic', 'unknown'],
  },
  isAvailable(env = process.env): boolean {
    return Boolean(env[ENV]?.trim());
  },
  async search(query, options): Promise<WebSearchResult> {
    const env = options?.env ?? process.env;
    const key = env[ENV]?.trim();
    if (!key) throw new Error(`${ENV} is not set`);

    const baseUrl = (env['SERPER_BASE_URL'] || BASE_URL).replace(/\/+$/, '');
    const raw = await fetchJson(`${baseUrl}/search`, {
      method: 'POST',
      signal: options?.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': key,
      },
      body: JSON.stringify({ q: query, num: 8 }),
    });

    const hits: WebSearchHit[] = [];
    if (isRecord(raw) && Array.isArray(raw['organic'])) {
      for (const item of raw['organic']) {
        if (!isRecord(item)) continue;
        const title = asString(item['title']);
        const link = asString(item['link']);
        if (!title || !link) continue;
        hits.push({
          title,
          url: link,
          snippet: asString(item['snippet']),
        });
        if (hits.length >= 8) break;
      }
    }
    if (hits.length === 0) {
      throw new Error('Serper returned no results');
    }
    return {
      hits,
      provider: 'serper',
      summary: formatHitsSummary(query, hits, 'serper'),
    };
  },
};
