/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { RoutingContext } from '../routingStrategy.js';
import type { Config } from '../../config/config.js';
import type { BaseLlmClient } from '../../core/baseLlmClient.js';
import type { LocalLiteRtLmClient } from '../../core/localLiteRtLmClient.js';
import { JevClassifierStrategy } from './jevClassifierStrategy.js';

const realSetTimeout = setTimeout;

const unhandledRejections: unknown[] = [];
const onUnhandledRejection = (reason: unknown) => {
  unhandledRejections.push(reason);
};

beforeAll(() => {
  process.on('unhandledRejection', onUnhandledRejection);
});

afterAll(() => {
  process.removeListener('unhandledRejection', onUnhandledRejection);
});

afterEach(() => {
  unhandledRejections.length = 0;
  vi.useRealTimers();
});

function realDelay(ms: number): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}

function makeConfig(): Config {
  return {
    getModel: () => 'gemini-2.5-pro',
    getGemini31Launched: vi.fn().mockResolvedValue(false),
    getUseCustomToolModel: vi.fn().mockResolvedValue(false),
    getHasAccessToPreviewModel: vi.fn().mockReturnValue(true),
    hasGemini35FlashGAAccess: vi.fn().mockReturnValue(false),
    getModelAvailabilityService: vi.fn().mockReturnValue({
      snapshot: vi.fn().mockReturnValue({ available: true }),
    }),
  } as unknown as Config;
}

/**
 * Regression coverage for an unhandled DOMException [AbortError] that SDK
 * 0.6.0 leaks when a request is aborted while its response body is still
 * draining: the SDK's buffered-body teardown rejects a pending read of its
 * cloned stream and nothing awaits it. The strategy's own catch handles the
 * SDK error, so only an unmocked transport run can observe the leak; the
 * tests in jevClassifierStrategy.test.ts mock the SDK and cannot. These
 * tests must keep the real SDK: the acceptance bar is zero unhandled
 * rejections in a bare consumer of @open-agent/core.
 */
describe('JevClassifierStrategy (real @typesafe-ai/sdk transport)', () => {
  let server: Server;
  let requestReceived: Promise<void>;
  let markRequestReceived: () => void;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"answers":');
      markRequestReceived();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected a TCP server address.');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  });

  beforeEach(() => {
    vi.stubEnv('JEV_API_KEY', 'test-jev-key');
    vi.stubEnv('TYPESAFE_BASE_URL', baseUrl);
    requestReceived = new Promise((resolve) => {
      markRequestReceived = resolve;
    });
  });

  function makeContext(signal?: AbortSignal): RoutingContext {
    return {
      history: [],
      request: 'simple task',
      ...(signal ? { signal } : {}),
    } as RoutingContext;
  }

  it('collects unhandled rejections (control for the assertions below)', () => {
    const sentinel = new Error('control sentinel');
    process.emit(
      'unhandledRejection',
      sentinel,
      Promise.resolve(),
    ) as unknown as void;

    expect(unhandledRejections).toEqual([sentinel]);
  });

  it('leaves zero unhandled rejections when the caller cancels mid-body-drain', async () => {
    const strategy = new JevClassifierStrategy();
    const callerController = new AbortController();

    const routePromise = strategy.route(
      makeContext(callerController.signal),
      makeConfig(),
      {} as BaseLlmClient,
      {} as LocalLiteRtLmClient,
    );
    await requestReceived;
    await realDelay(150);
    callerController.abort();

    await expect(routePromise).resolves.toBeNull();
    await realDelay(300);

    expect(unhandledRejections).toEqual([]);
  });

  it('leaves zero unhandled rejections when the strategy timeout fires mid-body-drain', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const strategy = new JevClassifierStrategy();

    const routePromise = strategy.route(
      makeContext(),
      makeConfig(),
      {} as BaseLlmClient,
      {} as LocalLiteRtLmClient,
    );
    await requestReceived;
    await realDelay(150);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(routePromise).resolves.toBeNull();
    vi.useRealTimers();
    await realDelay(300);

    expect(unhandledRejections).toEqual([]);
  });
});
