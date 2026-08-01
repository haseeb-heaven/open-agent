/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { exaBackend, parseExaMcpResponse } from './exa.js';

const SSE_PAYLOAD = `event: message
data: {"result":{"content":[{"type":"text","text":"Title: TypeScript: Handbook - The TypeScript Handbook\\nURL: https://www.typescriptlang.org/docs/handbook/intro\\nHighlights:\\nThe TypeScript Handbook explains the language."}]}}`;

describe('exaBackend', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is always available (no key needed)', () => {
    expect(exaBackend.isAvailable({})).toBe(true);
    expect(exaBackend.meta.freeNoKey).toBe(true);
    expect(exaBackend.meta.keyOptional).toBe(true);
  });

  it('calls MCP endpoint keyless when no EXA_API_KEY', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => SSE_PAYLOAD,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await exaBackend.search('neural query', { env: {} });
    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe('https://mcp.exa.ai/mcp');
    const headers = init.headers as Record<string, string>;
    expect(headers['Accept']).toContain('text/event-stream');
    const body = JSON.parse(String(init.body)) as {
      method: string;
      params: { name: string; arguments: { query: string } };
    };
    expect(body.method).toBe('tools/call');
    expect(body.params.name).toBe('web_search_exa');
    expect(body.params.arguments.query).toBe('neural query');
    expect(result.provider).toBe('exa');
    expect(result.hits[0].url).toBe(
      'https://www.typescriptlang.org/docs/handbook/intro',
    );
  });

  it('appends exaApiKey query param when EXA_API_KEY is set', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => SSE_PAYLOAD,
    }));
    vi.stubGlobal('fetch', fetchMock);

    await exaBackend.search('neural query', {
      env: { EXA_API_KEY: 'exa-test key' },
    });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain('?exaApiKey=');
    expect(url).toContain(encodeURIComponent('exa-test key'));
  });

  it('parses a direct JSON payload', () => {
    const text = parseExaMcpResponse(
      '{"result":{"content":[{"type":"text","text":"hello world"}]}}',
    );
    expect(text).toBe('hello world');
  });

  it('parses an SSE payload with data: lines', () => {
    const text = parseExaMcpResponse(SSE_PAYLOAD);
    expect(text).toContain('TypeScript: Handbook');
  });

  it('throws when Exa returns no text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        text: async () => `event: message\ndata: {"result":{"content":[]}}`,
      })),
    );
    await expect(
      exaBackend.search('neural query', { env: {} }),
    ).rejects.toThrow('Exa returned no results');
  });

  it('returns summary-only result when hits cannot be parsed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        text: async () =>
          'data: {"result":{"content":[{"type":"text","text":"No structured hits here."}]}}',
      })),
    );
    const result = await exaBackend.search('neural query', { env: {} });
    expect(result.hits).toHaveLength(0);
    expect(result.summary).toContain('No structured hits here.');
  });
});
