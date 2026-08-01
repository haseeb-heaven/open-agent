/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { asString, formatHitsSummary, isRecord } from '../httpJson.js';
import type {
  WebSearchBackend,
  WebSearchHit,
  WebSearchResult,
} from '../types.js';

const ENV = 'EXA_API_KEY';
const MCP_URL = 'https://mcp.exa.ai/mcp';

/** JSON-RPC request body for Exa's hosted MCP `web_search_exa` tool. */
function buildRequest(query: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'web_search_exa',
      arguments: {
        query,
        type: 'auto',
        numResults: 8,
        livecrawl: 'fallback',
        contextMaxCharacters: 10000,
      },
    },
  });
}

/**
 * Parse an MCP JSON-RPC response payload (direct JSON or SSE `data:` lines)
 * and return the first `content[].text`. Mirrors opencode's parseResponse.
 */
export function parseExaMcpResponse(body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed) return undefined;
  const candidates: string[] = [];
  if (trimmed.startsWith('{')) {
    candidates.push(trimmed);
  } else {
    for (const line of body.split('\n')) {
      if (line.startsWith('data: ')) candidates.push(line.slice(6));
    }
  }
  for (const candidate of candidates) {
    try {
      const raw: unknown = JSON.parse(candidate);
      if (!isRecord(raw)) continue;
      const result = raw['result'];
      if (!isRecord(result)) continue;
      const content = result['content'];
      if (!Array.isArray(content)) continue;
      for (const item of content) {
        if (!isRecord(item)) continue;
        const text = asString(item['text']);
        if (text) return text;
      }
    } catch {
      // malformed frame — try next candidate
    }
  }
  return undefined;
}

/**
 * Best-effort parse of Exa's text blob ("Title: … / URL: … / Highlights: …"
 * blocks) into normalized hits.
 */
function parseHits(text: string): WebSearchHit[] {
  const hits: WebSearchHit[] = [];
  const blocks = text.split(/\n(?=Title:)/);
  for (const block of blocks) {
    const title = block.match(/Title:\s*(.+)/)?.[1]?.trim();
    const url = block.match(/URL:\s*(https?:\/\/\S+)/i)?.[1]?.trim();
    if (!title || !url) continue;
    const snippetMatch = block.match(/Highlights:\s*([\s\S]*)$/);
    const snippet = snippetMatch
      ? snippetMatch[1]
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
          .join('\n')
      : undefined;
    hits.push({ title, url, snippet: snippet || undefined });
    if (hits.length >= 8) break;
  }
  return hits;
}

export const exaBackend: WebSearchBackend = {
  meta: {
    id: 'exa',
    displayName: 'Exa',
    envKey: ENV,
    signupUrl: 'https://dashboard.exa.ai/api-keys',
    notes:
      'Neural / semantic search via hosted MCP. Works with no key; add EXA_API_KEY for higher limits.',
    freeNoKey: true,
    keyOptional: true,
    recommendedFor: ['open_source', 'openai', 'anthropic', 'unknown'],
  },
  isAvailable(): boolean {
    return true;
  },
  async search(query, options): Promise<WebSearchResult> {
    const env = options?.env ?? process.env;
    const key = env[ENV]?.trim();
    const url = key
      ? `${MCP_URL}?exaApiKey=${encodeURIComponent(key)}`
      : MCP_URL;

    const res = await fetch(url, {
      method: 'POST',
      signal: options?.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: buildRequest(query),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Exa MCP HTTP ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`,
      );
    }

    const text = parseExaMcpResponse(await res.text());
    if (!text) {
      throw new Error('Exa returned no results');
    }

    const hits = parseHits(text);
    if (hits.length === 0) {
      return {
        hits: [],
        provider: 'exa',
        summary: `Web search results for "${query}" (via exa):\n\n${text}`,
      };
    }
    return {
      hits,
      provider: 'exa',
      summary: formatHitsSummary(query, hits, 'exa'),
    };
  },
};
