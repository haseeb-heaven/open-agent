/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { TestRig } from './test-helper.js';

describe('offline CLI argument contracts', () => {
  let rig: TestRig | undefined;

  afterEach(async () => {
    await rig?.cleanup();
    rig = undefined;
  });

  async function runInvalidArgs(args: string[], expectedMessage: string) {
    rig = new TestRig();
    await rig.setup('offline CLI argument contract');
    const result = await rig.runWithStreams(args);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(expectedMessage);
  }

  it('rejects multiple session restoration sources with a user-facing explanation', async () => {
    await runInvalidArgs(
      ['--resume', 'latest', '--session-id', 'session-1'],
      'The flags --resume, --session-id, and --session-file are mutually exclusive',
    );
  });

  it('rejects positional and named prompts together', async () => {
    await runInvalidArgs(
      ['positional prompt', '--prompt', 'named prompt'],
      'Cannot use both a positional prompt and the --prompt (-p) flag together',
    );
  });

  it('rejects headless and interactive prompt flags together', async () => {
    await runInvalidArgs(
      [
        '--prompt',
        'headless prompt',
        '--prompt-interactive',
        'interactive prompt',
      ],
      'Cannot use both --prompt (-p) and --prompt-interactive (-i) together',
    );
  });

  it('rejects the yolo shortcut alongside explicit approval mode', async () => {
    await runInvalidArgs(
      ['--yolo', '--approval-mode=auto'],
      'Cannot use both --yolo (-y) and --approval-mode together',
    );
  });

  it('rejects the auto-mode shortcut alongside explicit approval mode', async () => {
    await runInvalidArgs(
      ['--auto-mode', '--approval-mode=yolo'],
      'Cannot use both --auto-mode and --approval-mode together',
    );
  });

  it('rejects conflicting yolo and auto-mode approval shortcuts', async () => {
    await runInvalidArgs(
      ['--yolo', '--auto-mode'],
      'Cannot use both --yolo (-y) and --approval-mode together',
    );
  });

  it('rejects invalid output format with the accepted choices', async () => {
    await runInvalidArgs(
      ['--prompt', 'offline prompt', '--output-format=xml'],
      'Choices: "text", "json", "stream-json"',
    );
  });

  it('prints the provider model catalog and exits successfully without invoking a model', async () => {
    rig = new TestRig();
    await rig.setup('offline CLI models catalog');
    const result = await rig.runWithStreams(['--models']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('OpenAI');
    expect(result.stdout).toContain('gpt-4o-mini');
    expect(rig.readLastApiRequest()).toBeNull();
  });
});
