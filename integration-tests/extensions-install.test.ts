/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { TestRig } from './test-helper.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const extension = `{
  "name": "test-extension-install",
  "version": "0.0.1"
}`;

const extensionUpdate = `{
  "name": "test-extension-install",
  "version": "0.0.2"
}`;

describe('extension install', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  afterEach(async () => await rig.cleanup());

  it('installs a local extension, verifies a command, and updates it', async () => {
    await rig.setup('extension install test');
    const testServerPath = join(rig.testDir!, 'gemini-extension.json');
    writeFileSync(testServerPath, extension);
    const credentialFreeEnv = {
      OPENAI_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
      GROQ_API_KEY: undefined,
      DEEPSEEK_API_KEY: undefined,
      NVIDIA_API_KEY: undefined,
      TOGETHER_API_KEY: undefined,
      OPENROUTER_API_KEY: undefined,
      CEREBRAS_API_KEY: undefined,
      Z_AI_API_KEY: undefined,
      HF_TOKEN: undefined,
      HUGGINGFACE_API_KEY: undefined,
      BROWSER_USE_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
    };
    try {
      const result = await rig.runCommand(
        ['--debug', 'extensions', 'install', `${rig.testDir!}`],
        { stdin: 'y\n', env: credentialFreeEnv },
      );
      expect(result).toContain('test-extension-install');

      const listResult = await rig.runCommand(
        ['--debug', 'extensions', 'list'],
        { env: credentialFreeEnv },
      );
      expect(listResult).toContain('test-extension-install');
      writeFileSync(testServerPath, extensionUpdate);
      const updateResult = await rig.runCommand(
        ['--debug', 'extensions', 'update', `test-extension-install`],
        { stdin: 'y\n', env: credentialFreeEnv },
      );
      expect(updateResult).toContain('0.0.2');
    } finally {
      const uninstallResult = await rig.runCommand(
        ['extensions', 'uninstall', 'test-extension-install'],
        { env: credentialFreeEnv },
      );
      expect(uninstallResult).toContain('test-extension-install');
      const listAfterUninstall = await rig.runCommand(['extensions', 'list'], {
        env: credentialFreeEnv,
      });
      expect(listAfterUninstall).toContain('No extensions installed');
    }
  });
});
