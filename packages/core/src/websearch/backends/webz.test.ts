/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveWebzEndpoint, webzBackend, webzPublishedFrom } from './webz.js';

const TOKEN = 'webz-test-token';

function jsonResponse(body: unknown) {
  return {
    ok: true,
    json: async () => body,
    text: async () => '',
  };
}

describe('webzBackend', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is unavailable without WEBZ_API_TOKEN', () => {
    expect(webzBackend.isAvailable({})).toBe(false);
    expect(webzBackend.isAvailable({ WEBZ_API_TOKEN: '  ' })).toBe(false);
    expect(webzBackend.isAvailable({ WEBZ_API_TOKEN: TOKEN })).toBe(true);
  });

  it('rejects a non-https endpoint before the token is sent', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const error = await webzBackend
      .search('ai regulation', {
        env: {
          WEBZ_API_TOKEN: TOKEN,
          WEBZ_NEWS_SEARCH_URL: 'http://api.webz.io/api/news/context',
        },
      })
      .then(() => {
        throw new Error('search should have rejected the cleartext endpoint');
      })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/absolute https:\/\/ URL/);
    expect((error as Error).message).not.toContain(TOKEN);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resolveWebzEndpoint('https://api.webz.io/api/news/context')).toBe(
      'https://api.webz.io/api/news/context',
    );
    expect(() => resolveWebzEndpoint('http://example.test/news')).toThrow(
      /https/,
    );
    expect(() =>
      resolveWebzEndpoint('https://user:secret@example.test/news'),
    ).toThrow(/https/);
    expect(() => resolveWebzEndpoint('not a url')).toThrow(/https/);
  });

  it('posts the news context query with a bearer token and published_from', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        results: [
          {
            article: {
              title: 'Webz Hit',
              url: 'https://example.com/story',
              summary: 'summary text',
            },
            chunk: { text: 'chunk text' },
          },
          { article: { title: 'Missing URL' } },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await webzBackend.search('agent search', {
      env: { WEBZ_API_TOKEN: TOKEN },
    });

    expect(result.provider).toBe('webz');
    expect(result.hits).toEqual([
      {
        title: 'Webz Hit',
        url: 'https://example.com/story',
        snippet: 'chunk text',
      },
    ]);
    expect(result.summary).toContain('Webz Hit');
    expect(result.summary).toContain('via webz');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.webz.io/api/news/context');
    expect(url).not.toContain(TOKEN);
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      query: 'agent search',
      k: 8,
      filters: { published_from: webzPublishedFrom() },
    });
    expect(body).not.toHaveProperty('days');
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it('throws when the token is missing and does not call fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      webzBackend.search('agent search', { env: {} }),
    ).rejects.toThrow('WEBZ_API_TOKEN is not set');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when Webz returns no usable hits', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ results: [] })),
    );
    await expect(
      webzBackend.search('agent search', { env: { WEBZ_API_TOKEN: TOKEN } }),
    ).rejects.toThrow('Webz returned no results');
  });
});
