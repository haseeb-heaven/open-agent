/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { z } from 'zod';
import { TestRig } from './test-helper.js';

const timeout = 45_000;
const chatRequestSchema = z
  .object({ model: z.string(), stream: z.boolean() })
  .passthrough();

describe('offline Anthropic catalog routing through CLI', () => {
  let rig: TestRig | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    if (server?.listening) {
      const closed = once(server, 'close');
      server.close();
      await closed;
    }
    await rig?.cleanup();
    server = undefined;
    rig = undefined;
  });

  async function setup(responseStatus = 200) {
    rig = new TestRig();
    await rig.setup('offline-provider-routing', {
      settings: { security: { auth: { selectedType: 'multi-provider' } } },
    });
    const requests: Array<{
      headers: IncomingMessage['headers'];
      body: Record<string, unknown>;
    }> = [];
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString()) as unknown;
        } catch {
          response.writeHead(400).end('Malformed JSON');
          return;
        }
        const result = chatRequestSchema.safeParse(parsed);
        if (!result.success) {
          response.writeHead(400).end('Invalid request JSON');
          return;
        }
        requests.push({
          headers: request.headers,
          body: result.data,
        });
        response.writeHead(responseStatus, {
          'content-type':
            responseStatus === 200 ? 'text/event-stream' : 'application/json',
        });
        if (responseStatus !== 200) {
          response.end(
            JSON.stringify({ error: { message: 'fixture rejected request' } }),
          );
          return;
        }
        response.end(
          'data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"fixture answer"},"finish_reason":null}]}\n\n' +
            'data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
            'data: [DONE]\n\n',
        );
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No loopback port');
    const modelsPath = join(rig.testDir!, 'configs', 'models.toml');
    mkdirSync(join(rig.testDir!, 'configs'), { recursive: true });
    writeFileSync(
      modelsPath,
      `schema_version = 1\ndefault_model = "claude-opus-5"\n\n[models."claude-opus-5"]\nmodel = "claude-opus-5"\nprovider = "anthropic"\napi_base = "http://127.0.0.1:${address.port}/v1"\n\n[models."claude-fable-5-1"]\nmodel = "claude-fable-5-1"\nprovider = "anthropic"\napi_base = "http://127.0.0.1:${address.port}/v1"\n`,
    );
    return { requests, modelsPath };
  }

  it.each(['claude-opus-5', 'claude-fable-5-1'])(
    'routes catalog model %s to the configured loopback endpoint and renders the result',
    async (model) => {
      const { requests, modelsPath } = await setup();
      const output = await rig!.run({
        args: [
          '-p',
          'Return a short answer.',
          '--provider',
          'anthropic',
          '--model',
          model,
        ],
        env: {
          OPENAGENT_MODELS_TOML: modelsPath,
          ANTHROPIC_API_KEY: 'offline-test-key',
        },
        timeout,
      });
      expect(output).toContain('fixture answer');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.body['model']).toBe(model);
      expect(requests[0]?.body['stream']).toBe(true);
      expect(requests[0]?.headers['authorization']).toBe(
        'Bearer offline-test-key',
      );
      expect(requests[0]?.headers['content-type']).toContain(
        'application/json',
      );
    },
    timeout + 10_000,
  );

  it(
    'surfaces a provider HTTP rejection instead of treating it as a model answer',
    async () => {
      const { requests, modelsPath } = await setup(401);
      await expect(
        rig!.run({
          args: [
            '-p',
            'Return a short answer.',
            '--provider',
            'anthropic',
            '--model',
            'claude-opus-5',
          ],
          env: {
            OPENAGENT_MODELS_TOML: modelsPath,
            ANTHROPIC_API_KEY: 'offline-test-key',
          },
          timeout,
        }),
      ).rejects.toThrow();
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers['authorization']).toBe(
        'Bearer offline-test-key',
      );
    },
    timeout + 10_000,
  );

  it(
    'fails closed before network access when the Anthropic credential is absent',
    async () => {
      const { requests, modelsPath } = await setup();
      await expect(
        rig!.run({
          args: [
            '-p',
            'Return a short answer.',
            '--provider',
            'anthropic',
            '--model',
            'claude-fable-5-1',
          ],
          env: { OPENAGENT_MODELS_TOML: modelsPath, ANTHROPIC_API_KEY: '' },
          timeout,
        }),
      ).rejects.toThrow();
      expect(requests).toHaveLength(0);
    },
    timeout + 10_000,
  );
});
