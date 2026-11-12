/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestRig } from './test-helper.js';

describe('offline filesystem CLI boundaries', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  afterEach(async () => await rig.cleanup());

  async function runWithTool(
    tool: string,
    args: Record<string, unknown>,
    prompt: string,
    expectSuccess = true,
  ) {
    const responsesPath = rig.fakeResponsesPath!;
    writeFileSync(
      responsesPath,
      [
        JSON.stringify({
          method: 'generateContentStream',
          response: [
            {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [{ functionCall: { name: tool, args } }],
                  },
                  finishReason: 'STOP',
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
                    parts: [{ text: 'Filesystem task finished.' }],
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
    const result = await rig.run({
      args: prompt,
      env: { GEMINI_API_KEY: 'offline-fixture-key' },
    });
    expect(result).toContain('Filesystem task finished.');
    if (expectSuccess) {
      await rig.expectToolCallSuccess([tool]);
    } else {
      await rig.waitForToolCall(tool);
    }
    return result;
  }

  it('reads a zero-byte file through the CLI', async () => {
    await rig.setup('read zero-byte file', {
      fakeResponsesPath: join(import.meta.dirname, 'parallel-tools.responses'),
      settings: { tools: { core: ['read_file'] } },
    });
    rig.createFile('empty.txt', '');
    await runWithTool(
      'read_file',
      { file_path: 'empty.txt' },
      'read empty file',
    );
    expect(
      rig
        .readToolLogs()
        .some((entry) => entry.toolRequest.name === 'read_file'),
    ).toBe(true);
  });

  it('renders UTF-8 file content from the CLI tool result', async () => {
    await rig.setup('read UTF-8 content', {
      fakeResponsesPath: join(import.meta.dirname, 'parallel-tools.responses'),
      settings: { tools: { core: ['read_file'] } },
    });
    rig.createFile('unicode.txt', 'café — 東京');
    const output = await runWithTool(
      'read_file',
      { file_path: 'unicode.txt' },
      'read unicode text',
    );
    expect(output).toContain('Filesystem task finished.');
    expect(rig.readToolLogs()[0]?.toolRequest.success).toBe(true);
  });

  it('returns a safe error when read_file targets a directory', async () => {
    await rig.setup('read directory path', {
      fakeResponsesPath: join(import.meta.dirname, 'parallel-tools.responses'),
      settings: { tools: { core: ['read_file'] } },
    });
    rig.mkdir('folder');
    await runWithTool(
      'read_file',
      { file_path: 'folder' },
      'read a directory',
      false,
    );
    expect(rig.readToolLogs()[0]?.toolRequest.success).toBe(false);
  });
});
