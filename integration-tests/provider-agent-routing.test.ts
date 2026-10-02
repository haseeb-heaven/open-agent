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

type ChatMessage = { role: string; content?: string | null };
type ChatRequest = {
  model: string;
  stream: boolean;
  tools?: Array<{
    type: string;
    function: { name: string; parameters?: Record<string, unknown> };
  }>;
  messages: ChatMessage[];
};

const chatRequestSchema = z
  .object({
    model: z.string(),
    stream: z.boolean(),
    tools: z
      .array(
        z.object({
          type: z.string(),
          function: z.object({
            name: z.string(),
            parameters: z.record(z.string(), z.unknown()).optional(),
          }),
        }),
      )
      .optional(),
    messages: z.array(
      z.object({
        role: z.string(),
        content: z.string().nullable().optional(),
      }),
    ),
  })
  .passthrough();

const REQUEST_TIMEOUT_MS = 10_000;
const CLI_TIMEOUT_MS = 45_000;

describe('provider agent routing E2E', () => {
  let rig: TestRig | undefined;
  let server: Server | undefined;
  let requestFailure: Error | undefined;

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

  it(
    'routes a real CLI tool call through the configured local OpenAI provider',
    async () => {
      rig = new TestRig();
      await rig.setup('provider-agent-routing', {
        settings: { security: { auth: { selectedType: 'multi-provider' } } },
      });
      const fixtureContents = 'local provider fixture contents';
      rig.createFile('routing-fixture.txt', fixtureContents);

      const requests: Array<{
        headers: IncomingMessage['headers'];
        body: ChatRequest;
      }> = [];
      server = createServer((request, response) => {
        request.setTimeout(REQUEST_TIMEOUT_MS, () => {
          requestFailure = new Error('Local provider request timed out');
          response.destroy(requestFailure);
        });
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString()) as unknown;
          } catch {
            requestFailure = new Error(
              'Local provider received malformed JSON',
            );
            response.writeHead(400).end('Malformed JSON');
            return;
          }
          const result = chatRequestSchema.safeParse(parsed);
          if (!result.success) {
            requestFailure = new Error(
              `Local provider received invalid request JSON: ${result.error.message}`,
            );
            response.writeHead(400).end('Invalid request JSON');
            return;
          }
          const body: ChatRequest = result.data;
          requests.push({ headers: request.headers, body });
          response.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          const emit = (payload: unknown) =>
            response.write(`data: ${JSON.stringify(payload)}\n\n`);
          if (requests.length === 1) {
            emit({
              id: 'local-1',
              object: 'chat.completion.chunk',
              model: 'fixture-chat-model',
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call-read',
                        type: 'function',
                        function: {
                          name: 'read_file',
                          arguments: JSON.stringify({
                            file_path: 'routing-fixture.txt',
                          }),
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            });
            emit({
              id: 'local-1',
              object: 'chat.completion.chunk',
              model: 'fixture-chat-model',
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            });
          } else {
            emit({
              id: 'local-2',
              object: 'chat.completion.chunk',
              model: 'fixture-chat-model',
              choices: [
                {
                  index: 0,
                  delta: {
                    content: 'Local model read the fixture successfully.',
                  },
                  finish_reason: null,
                },
              ],
            });
            emit({
              id: 'local-2',
              object: 'chat.completion.chunk',
              model: 'fixture-chat-model',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            });
          }
          response.write('data: [DONE]\n\n');
          response.end();
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Local server did not bind a TCP port');
      }

      const modelsPath = join(rig.testDir!, 'configs', 'models.toml');
      mkdirSync(join(rig.testDir!, 'configs'), { recursive: true });
      writeFileSync(
        modelsPath,
        `schema_version = 1\ndefault_model = "local-openai-test"\n\n[models."local-openai-test"]\nmodel = "fixture-chat-model"\nprovider = "openai"\napi_base = "http://127.0.0.1:${address.port}/v1"\n`,
      );

      const output = await rig.run({
        args: [
          '-p',
          'Read routing-fixture.txt and report its contents.',
          '--provider',
          'openai',
          '--model',
          'local-openai-test',
        ],
        env: {
          OPENAGENT_MODELS_TOML: modelsPath,
          OPENAI_API_KEY: 'test-only-local-key',
        },
        timeout: CLI_TIMEOUT_MS,
      });

      expect(requestFailure).toBeUndefined();
      expect(output).toContain('Local model read the fixture successfully.');
      expect(requests).toHaveLength(2);
      expect(requests.map(({ body }) => body.model)).toEqual([
        'fixture-chat-model',
        'fixture-chat-model',
      ]);
      expect(requests.every(({ body }) => body.stream)).toBe(true);
      expect(requests[0].headers['authorization']).toBe(
        'Bearer test-only-local-key',
      );
      expect(requests[0].body.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'function',
            function: expect.objectContaining({ name: 'read_file' }),
          }),
        ]),
      );
      const toolResult = requests[1].body.messages.find(
        (message) => message.role === 'tool',
      );
      expect(toolResult?.content).toContain(fixtureContents);
    },
    CLI_TIMEOUT_MS + 10_000,
  );
});
