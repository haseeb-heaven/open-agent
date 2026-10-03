/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestRig } from './test-helper.js';
import { getShellConfiguration } from '../packages/core/src/utils/shell-utils.js';

const { shell } = getShellConfiguration();

function getAllowedListCommand(): string {
  switch (shell) {
    case 'powershell':
      return 'Get-ChildItem';
    case 'cmd':
      return 'dir';
    case 'bash':
    default:
      return 'ls';
  }
}

function getChainedEchoCommand(): { allowPattern: string; command: string } {
  const secondCommand = getAllowedListCommand();
  switch (shell) {
    case 'powershell':
      return {
        allowPattern: 'Write-Output',
        command: `Write-Output "foo" && ${secondCommand}`,
      };
    case 'cmd':
      return {
        allowPattern: 'echo',
        command: `echo "foo" && ${secondCommand}`,
      };
    case 'bash':
    default:
      return {
        allowPattern: 'echo',
        command: `echo "foo" && ${secondCommand}`,
      };
  }
}

describe('run_shell_command', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  afterEach(async () => await rig.cleanup());
  it.skip('should reject chained commands when only the first segment is allowlisted in non-interactive mode', async () => {
    await rig.setup(
      'should reject chained commands when only the first segment is allowlisted',
    );

    const chained = getChainedEchoCommand();
    const shellInjection = `!{${chained.command}}`;

    await rig.run({
      args: `--allowed-tools=ShellTool(${chained.allowPattern})`,
      stdin: `${shellInjection}\n`,
      approvalMode: 'default',
    });

    // CLI should refuse to execute the chained command without scheduling run_shell_command.
    const toolLogs = rig
      .readToolLogs()
      .filter((log) => log.toolRequest.name === 'run_shell_command');

    // Success is false because tool is in the scheduled state.
    for (const log of toolLogs) {
      expect(log.toolRequest.success).toBe(false);
      expect(log.toolRequest.args).toContain('&&');
    }
  });
});
