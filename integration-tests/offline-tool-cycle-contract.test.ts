/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import fs from 'node:fs';
import { TestRig } from './test-helper.js';

describe('Headless tool-cycle contract', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  afterEach(async () => {
    await rig.cleanup();
  });

  it('returns an unknown-tool error to the model and resumes to a final answer', async () => {
    rig.setup('unknown-tool-resumption', {
      settings: { tools: { core: [] } },
    });

    const fixturePath = join(rig.testDir!, 'unknown-tool-responses.jsonl');
    fs.writeFileSync(
      fixturePath,
      [
        JSON.stringify({
          method: 'generateContentStream',
          response: [
            {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [
                      {
                        functionCall: {
                          name: 'not_a_registered_tool',
                          args: { unexpected: 'value' },
                        },
                      },
                    ],
                  },
                  index: 0,
                },
              ],
            },
          ],
        }),
        JSON.stringify({
          method: 'generateContentStream',
          response: [
            {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [
                      { text: 'Recovered after the unknown tool error.' },
                    ],
                  },
                  finishReason: 'STOP',
                  index: 0,
                },
              ],
            },
          ],
        }),
      ].join('\n'),
    );
    rig.fakeResponsesPath = fixturePath;

    const result = await rig.run({
      args: ['-p', 'Use the requested tool and report what happened.'],
      approvalMode: 'default',
      env: { GEMINI_API_KEY: 'offline-test-key' },
    });

    const unknownToolCall = rig
      .readToolLogs()
      .find((log) => log.toolRequest.name === 'not_a_registered_tool');
    expect(unknownToolCall).toBeDefined();
    expect(unknownToolCall?.toolRequest.success).toBe(false);
    expect(result).toContain('Recovered after the unknown tool error.');
  });

  it('returns invalid tool arguments to the model and resumes to a final answer', async () => {
    rig.setup('invalid-tool-arguments-resumption', {
      settings: { tools: { core: ['read_file'] } },
    });

    const fixturePath = join(rig.testDir!, 'invalid-arguments-responses.jsonl');
    fs.writeFileSync(
      fixturePath,
      [
        JSON.stringify({
          method: 'generateContentStream',
          response: [
            {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [
                      {
                        functionCall: {
                          name: 'read_file',
                          args: { file_path: 17 },
                        },
                      },
                    ],
                  },
                  index: 0,
                },
              ],
            },
          ],
        }),
        JSON.stringify({
          method: 'generateContentStream',
          response: [
            {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [{ text: 'Recovered after invalid arguments.' }],
                  },
                  finishReason: 'STOP',
                  index: 0,
                },
              ],
            },
          ],
        }),
      ].join('\n'),
    );
    rig.fakeResponsesPath = fixturePath;

    const result = await rig.run({
      args: ['-p', 'Read the requested file and report what happened.'],
      approvalMode: 'default',
      env: { GEMINI_API_KEY: 'offline-test-key' },
    });

    const invalidCall = rig
      .readToolLogs()
      .find((log) => log.toolRequest.name === 'read_file');
    expect(invalidCall).toBeDefined();
    expect(invalidCall?.toolRequest.success).toBe(false);
    expect(result).toContain('Recovered after invalid arguments.');
  });
});
