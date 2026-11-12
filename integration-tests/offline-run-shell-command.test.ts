/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  TestRig,
  printDebugInfo,
  assertModelHasOutput,
  checkModelOutputContent,
} from './test-helper.js';
import { getShellConfiguration } from '../packages/core/src/utils/shell-utils.js';

const { shell } = getShellConfiguration();

function getLineCountCommand(): { command: string; tool: string } {
  switch (shell) {
    case 'powershell':
      return {
        command: 'Get-Content test.txt | Measure-Object -Line',
        tool: 'Measure-Object',
      };
    case 'cmd':
      return { command: 'find /c /v "" test.txt', tool: 'find' };
    case 'bash':
    default:
      return { command: 'wc -l test.txt', tool: 'wc' };
  }
}

function getInvalidCommand(): string {
  switch (shell) {
    case 'powershell':
      return `Get-ChildItem | | Select-Object`;
    case 'cmd':
      return `dir | | findstr foo`;
    case 'bash':
    default:
      return `if then`;
  }
}

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

function getDisallowedFileReadCommand(testFile: string): {
  command: string;
  tool: string;
} {
  const quotedPath = `"${testFile}"`;
  switch (shell) {
    case 'powershell':
      return { command: `Get-Content ${quotedPath}`, tool: 'Get-Content' };
    case 'cmd':
      return { command: `type ${quotedPath}`, tool: 'type' };
    case 'bash':
    default:
      return { command: `cat ${quotedPath}`, tool: 'cat' };
  }
}

describe('run_shell_command', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  afterEach(async () => await rig.cleanup());
  it('should be able to run a shell command', async () => {
    await rig.setup('should be able to run a shell command', {
      fakeResponsesPath: join(
        import.meta.dirname,
        'run-shell-command.echo.responses',
      ),
      settings: { tools: { core: ['run_shell_command'] } },
    });

    const prompt = `Please run the command "echo hello-world" and show me the output`;

    const result = await rig.run({
      env: { GEMINI_API_KEY: 'offline-fixture-key' },
      args: prompt,
    });

    const foundToolCall = await rig.waitForToolCall('run_shell_command');

    // Add debugging information
    if (!foundToolCall || !result.includes('hello-world')) {
      printDebugInfo(rig, result, {
        'Found tool call': foundToolCall,
        'Contains hello-world': result.includes('hello-world'),
      });
    }

    expect(
      foundToolCall,
      'Expected to find a run_shell_command tool call',
    ).toBeTruthy();

    assertModelHasOutput(result);
    checkModelOutputContent(result, {
      expectedContent: ['hello-world', 'exit code 0'],
      testName: 'Shell command test',
    });
  });

  it('should be able to run a shell command via stdin', async () => {
    await rig.setup('should be able to run a shell command via stdin', {
      fakeResponsesPath: join(
        import.meta.dirname,
        'run-shell-command.stdin.responses',
      ),
      settings: { tools: { core: ['run_shell_command'] } },
    });

    const prompt = `Please run the command "echo test-stdin" and show me what it outputs`;

    const result = await rig.run({
      env: { GEMINI_API_KEY: 'offline-fixture-key' },
      stdin: prompt,
    });

    const foundToolCall = await rig.waitForToolCall('run_shell_command');

    // Add debugging information
    if (!foundToolCall || !result.includes('test-stdin')) {
      printDebugInfo(rig, result, {
        'Test type': 'Stdin test',
        'Found tool call': foundToolCall,
        'Contains test-stdin': result.includes('test-stdin'),
      });
    }

    expect(
      foundToolCall,
      'Expected to find a run_shell_command tool call',
    ).toBeTruthy();

    assertModelHasOutput(result);
    checkModelOutputContent(result, {
      expectedContent: 'test-stdin',
      testName: 'Shell command stdin test',
    });
  });

  it('should run allowed sub-command in non-interactive mode', async () => {
    await rig.setup('should run allowed sub-command in non-interactive mode', {
      fakeResponsesPath: join(
        import.meta.dirname,
        `run-shell-command.allow-subcommand.${shell}.responses`,
      ),
    });

    rig.createFile('test.txt', 'Lorem\nIpsum\nDolor\n');
    const { tool, command } = getLineCountCommand();
    const prompt = `use ${command} to tell me how many lines there are in test.txt`;

    // Provide the prompt via stdin to simulate non-interactive mode
    const result = await rig.run({
      env: { GEMINI_API_KEY: 'offline-fixture-key' },
      args: [`--allowed-tools=run_shell_command(${tool})`],
      stdin: prompt,
      approvalMode: 'default',
    });

    const foundToolCall = await rig.waitForToolCall('run_shell_command', 15000);

    if (!foundToolCall) {
      const toolLogs = rig.readToolLogs().map(({ toolRequest }) => ({
        name: toolRequest.name,
        success: toolRequest.success,
        args: toolRequest.args,
      }));
      printDebugInfo(rig, result, {
        'Found tool call': foundToolCall,
        'Allowed tools flag': `run_shell_command(${tool})`,
        Prompt: prompt,
        'Tool logs': toolLogs,
        Result: result,
      });
    }

    expect(
      foundToolCall,
      'Expected to find a run_shell_command tool call',
    ).toBeTruthy();

    const toolCall = rig
      .readToolLogs()
      .filter(
        (toolCall) => toolCall.toolRequest.name === 'run_shell_command',
      )[0];
    expect(toolCall.toolRequest.success).toBe(true);
  });

  it('should succeed with no parens in non-interactive mode', async () => {
    await rig.setup('should succeed with no parens in non-interactive mode', {
      fakeResponsesPath: join(
        import.meta.dirname,
        `run-shell-command.no-parens.${shell}.responses`,
      ),
    });

    rig.createFile('test.txt', 'Lorem\nIpsum\nDolor\n');
    const { command } = getLineCountCommand();
    const prompt = `use ${command} to tell me how many lines there are in test.txt`;

    const result = await rig.run({
      env: { GEMINI_API_KEY: 'offline-fixture-key' },
      args: '--allowed-tools=run_shell_command',
      stdin: prompt,
      approvalMode: 'default',
    });

    const foundToolCall = await rig.waitForToolCall('run_shell_command', 15000);

    if (!foundToolCall) {
      printDebugInfo(rig, result, {
        'Found tool call': foundToolCall,
      });
    }

    expect(
      foundToolCall,
      'Expected to find a run_shell_command tool call',
    ).toBeTruthy();

    const toolCall = rig
      .readToolLogs()
      .filter(
        (toolCall) => toolCall.toolRequest.name === 'run_shell_command',
      )[0];
    expect(toolCall.toolRequest.success).toBe(true);
  });

  it('should succeed in yolo mode', async () => {
    const isWindows = process.platform === 'win32';
    await rig.setup('should succeed in yolo mode', {
      fakeResponsesPath: join(
        import.meta.dirname,
        `run-shell-command.yolo.${shell}.responses`,
      ),
      settings: {
        tools: { core: ['run_shell_command'] },
        shell: isWindows ? { enableInteractiveShell: false } : undefined,
      },
    });

    rig.createFile('test.txt', 'Lorem\nIpsum\nDolor\n');
    const { command } = getLineCountCommand();
    const prompt = `use ${command} to tell me how many lines there are in test.txt`;

    const result = await rig.run({
      env: { GEMINI_API_KEY: 'offline-fixture-key' },
      args: prompt,
      approvalMode: 'yolo',
    });

    const foundToolCall = await rig.waitForToolCall('run_shell_command', 15000);

    if (!foundToolCall) {
      printDebugInfo(rig, result, {
        'Found tool call': foundToolCall,
      });
    }

    expect(
      foundToolCall,
      'Expected to find a run_shell_command tool call',
    ).toBeTruthy();

    const toolCall = rig
      .readToolLogs()
      .filter(
        (toolCall) => toolCall.toolRequest.name === 'run_shell_command',
      )[0];
    expect(toolCall.toolRequest.success).toBe(true);
  });

  it('should work with ShellTool alias', async () => {
    await rig.setup('should work with ShellTool alias', {
      fakeResponsesPath: join(
        import.meta.dirname,
        `run-shell-command.alias.${shell}.responses`,
      ),
    });

    rig.createFile('test.txt', 'Lorem\nIpsum\nDolor\n');
    const { tool, command } = getLineCountCommand();
    const prompt = `use ${command} to tell me how many lines there are in test.txt`;

    const result = await rig.run({
      env: { GEMINI_API_KEY: 'offline-fixture-key' },
      args: `--allowed-tools=ShellTool(${tool})`,
      stdin: prompt,
      approvalMode: 'default',
    });

    const foundToolCall = await rig.waitForToolCall('run_shell_command', 15000);

    if (!foundToolCall) {
      const toolLogs = rig.readToolLogs().map(({ toolRequest }) => ({
        name: toolRequest.name,
        success: toolRequest.success,
        args: toolRequest.args,
      }));
      printDebugInfo(rig, result, {
        'Found tool call': foundToolCall,
        'Allowed tools flag': `ShellTool(${tool})`,
        Prompt: prompt,
        'Tool logs': toolLogs,
        Result: result,
      });
    }

    expect(
      foundToolCall,
      'Expected to find a run_shell_command tool call',
    ).toBeTruthy();

    const toolCall = rig
      .readToolLogs()
      .filter(
        (toolCall) => toolCall.toolRequest.name === 'run_shell_command',
      )[0];
    expect(toolCall.toolRequest.success).toBe(true);
  });

  // TODO(#11062): Un-skip this once we can make it reliable by using hard coded
  // model responses.
  it('should combine multiple --allowed-tools flags', async () => {
    await rig.setup('should combine multiple --allowed-tools flags', {
      fakeResponsesPath: join(
        import.meta.dirname,
        `run-shell-command.multiple-flags.${shell}.responses`,
      ),
    });

    const { tool, command } = getLineCountCommand();
    const prompt =
      `use both ${command} and ${getAllowedListCommand()} to count the number of lines in files in this ` +
      `directory. Do not pipe these commands into each other, run them separately.`;

    const result = await rig.run({
      env: { GEMINI_API_KEY: 'offline-fixture-key' },
      args: [
        `--allowed-tools=run_shell_command(${tool})`,
        `--allowed-tools=run_shell_command(${getAllowedListCommand()})`,
      ],
      stdin: prompt,
      approvalMode: 'default',
    });

    for (const expected of [getAllowedListCommand(), tool]) {
      const foundToolCall = await rig.waitForToolCall(
        'run_shell_command',
        15000,
        (args) => args.toLowerCase().includes(`"command": "${expected}`),
      );

      if (!foundToolCall) {
        printDebugInfo(rig, result, {
          'Found tool call': foundToolCall,
        });
      }

      expect(
        foundToolCall,
        `Expected to find a run_shell_command tool call to "${expected}",` +
          ` got ${rig.readToolLogs().join('\n')}`,
      ).toBeTruthy();
    }

    const toolLogs = rig
      .readToolLogs()
      .filter((toolCall) => toolCall.toolRequest.name === 'run_shell_command');
    expect(toolLogs.length, toolLogs.join('\n')).toBeGreaterThanOrEqual(2);
    for (const toolLog of toolLogs) {
      expect(
        toolLog.toolRequest.success,
        `Expected tool call ${toolLog} to succeed`,
      ).toBe(true);
    }
  });

  it('should reject commands not on the allowlist', async () => {
    await rig.setup('should reject commands not on the allowlist', {
      fakeResponsesPath: join(
        import.meta.dirname,
        `run-shell-command.reject-disallowed.${shell}.responses`,
      ),
      settings: { tools: { core: ['run_shell_command'] } },
    });

    rig.createFile('test.txt', 'offline-disallowed-secret-contents\n');
    const allowedCommand = getAllowedListCommand();
    const disallowed = getDisallowedFileReadCommand('test.txt');
    const prompt =
      `I am testing the allowed tools configuration. ` +
      `Attempt to run "${disallowed.command}" to read the contents of test.txt. ` +
      `If the command fails because it is not permitted, respond with the single word FAIL. ` +
      `If it succeeds, respond with SUCCESS.`;

    const result = await rig.run({
      env: { GEMINI_API_KEY: 'offline-fixture-key' },
      args: `--allowed-tools=run_shell_command(${allowedCommand})`,
      stdin: prompt,
      approvalMode: 'default',
    });

    if (!result.toLowerCase().includes('fail')) {
      printDebugInfo(rig, result, {
        Result: result,
        AllowedCommand: allowedCommand,
        DisallowedCommand: disallowed.command,
      });
    }
    expect(result).toContain('FAIL');

    const foundToolCall = await rig.waitForToolCall(
      'run_shell_command',
      15000,
      (args) => args.toLowerCase().includes(disallowed.tool.toLowerCase()),
    );

    if (!foundToolCall) {
      printDebugInfo(rig, result, {
        'Found tool call': foundToolCall,
        ToolLogs: rig.readToolLogs(),
      });
    }
    expect(foundToolCall).toBe(true);

    const toolLogs = rig
      .readToolLogs()
      .filter((toolLog) => toolLog.toolRequest.name === 'run_shell_command');
    const failureLog = toolLogs.find((toolLog) =>
      toolLog.toolRequest.args
        .toLowerCase()
        .includes(disallowed.tool.toLowerCase()),
    );

    if (!failureLog || failureLog.toolRequest.success) {
      printDebugInfo(rig, result, {
        ToolLogs: toolLogs,
        DisallowedTool: disallowed.tool,
      });
    }

    expect(
      failureLog,
      'Expected failing run_shell_command invocation',
    ).toBeTruthy();
    expect(failureLog!.toolRequest.success).toBe(false);
    expect(result).not.toContain('offline-disallowed-secret-contents');
  });

  it('should allow all with "ShellTool" and other specific tools', async () => {
    await rig.setup(
      'should allow all with "ShellTool" and other specific tools',
      {
        fakeResponsesPath: join(
          import.meta.dirname,
          'run-shell-command.allow-all.responses',
        ),
        settings: { tools: { core: ['run_shell_command'] } },
      },
    );

    const { tool } = getLineCountCommand();
    const prompt = `Please run the command "echo test-allow-all" and show me the output`;

    const result = await rig.run({
      env: { GEMINI_API_KEY: 'offline-fixture-key' },
      args: [
        `--allowed-tools=run_shell_command(${tool})`,
        '--allowed-tools=run_shell_command',
      ],
      stdin: prompt,
      approvalMode: 'default',
    });

    const foundToolCall = await rig.waitForToolCall('run_shell_command', 15000);

    if (!foundToolCall || !result.includes('test-allow-all')) {
      printDebugInfo(rig, result, {
        'Found tool call': foundToolCall,
        Result: result,
      });
    }

    expect(
      foundToolCall,
      'Expected to find a run_shell_command tool call',
    ).toBeTruthy();

    const toolCall = rig
      .readToolLogs()
      .filter(
        (toolCall) => toolCall.toolRequest.name === 'run_shell_command',
      )[0];
    expect(toolCall.toolRequest.success).toBe(true);

    assertModelHasOutput(result);
    checkModelOutputContent(result, {
      expectedContent: 'test-allow-all',
      testName: 'Shell command stdin allow all',
    });
  });

  it('should propagate environment variables to the child process', async () => {
    await rig.setup('should propagate environment variables', {
      fakeResponsesPath: join(
        import.meta.dirname,
        'run-shell-command.environment.responses',
      ),
      settings: { tools: { core: ['run_shell_command'] } },
    });

    const varName = 'GEMINI_CLI_TEST_VAR';
    const varValue = 'offline-env-value';
    const prompt = `Run node -e "process.stdout.write(process.env.${varName} ?? '')" and show me its output.`;
    const result = await rig.run({
      env: {
        GEMINI_API_KEY: 'offline-fixture-key',
        GEMINI_CLI_TEST_VAR: 'offline-env-value',
      },
      args: prompt,
    });

    const foundToolCall = await rig.waitForToolCall('run_shell_command');

    if (!foundToolCall || !result.includes(varValue)) {
      printDebugInfo(rig, result, {
        'Found tool call': foundToolCall,
        'Contains varValue': result.includes(varValue),
      });
    }

    expect(
      foundToolCall,
      'Expected to find a run_shell_command tool call',
    ).toBeTruthy();
    assertModelHasOutput(result);
    checkModelOutputContent(result, {
      expectedContent: varValue,
      testName: 'Env var propagation test',
    });
    expect(result).toContain(varValue);
  });

  it('should run a platform-specific file listing command', async () => {
    await rig.setup('should run platform-specific file listing', {
      fakeResponsesPath: join(
        import.meta.dirname,
        `run-shell-command.platform-listing.${shell}.responses`,
      ),
    });
    const fileName = 'test-file.txt';
    rig.createFile(fileName, 'test content');

    const prompt = `Run a shell command to list the files in the current directory and tell me what they are.`;
    const result = await rig.run({
      env: { GEMINI_API_KEY: 'offline-fixture-key' },
      args: prompt,
    });

    const foundToolCall = await rig.waitForToolCall('run_shell_command');

    // Debugging info
    if (!foundToolCall || !result.includes(fileName)) {
      printDebugInfo(rig, result, {
        'Found tool call': foundToolCall,
        'Contains fileName': result.includes(fileName),
      });
    }

    expect(
      foundToolCall,
      'Expected to find a run_shell_command tool call',
    ).toBeTruthy();

    assertModelHasOutput(result);
    checkModelOutputContent(result, {
      expectedContent: fileName,
      testName: 'Platform-specific listing test',
    });
    expect(result).toContain(fileName);
  });

  it('rejects invalid shell expressions', async () => {
    await rig.setup('rejects invalid shell expressions', {
      fakeResponsesPath: join(
        import.meta.dirname,
        `run-shell-command.invalid-expression.${shell}.responses`,
      ),
      settings: {
        tools: {
          core: ['run_shell_command'],
          allowed: ['run_shell_command(echo)'], // Specifically allow echo
        },
      },
    });
    const invalidCommand = getInvalidCommand();
    const result = await rig.run({
      env: { GEMINI_API_KEY: 'offline-fixture-key' },
      args: `I am testing the error handling of the run_shell_command tool. Please attempt to run the following command, which I know has invalid syntax: \`${invalidCommand}\`. If the command fails as expected, please return the word FAIL, otherwise return the word SUCCESS.`,
      approvalMode: 'default', // Use default mode so safety fallback triggers confirmation
    });
    expect(result).toContain('FAIL');
    expect(existsSync(join(rig.testDir!, 'file'))).toBe(false);

    const escapedInvalidCommand = JSON.stringify(invalidCommand).slice(1, -1);
    const foundToolCall = await rig.waitForToolCall(
      'run_shell_command',
      15000,
      (args) =>
        args.toLowerCase().includes(escapedInvalidCommand.toLowerCase()),
    );

    if (!foundToolCall) {
      printDebugInfo(rig, result, {
        'Found tool call': foundToolCall,
        EscapedCommand: escapedInvalidCommand,
        ToolLogs: rig.readToolLogs(),
      });
    }
    expect(foundToolCall).toBe(true);

    const toolLogs = rig
      .readToolLogs()
      .filter((toolLog) => toolLog.toolRequest.name === 'run_shell_command');
    const failureLog = toolLogs.find((toolLog) =>
      toolLog.toolRequest.args
        .toLowerCase()
        .includes(escapedInvalidCommand.toLowerCase()),
    );

    if (!failureLog || failureLog.toolRequest.success) {
      printDebugInfo(rig, result, {
        ToolLogs: toolLogs,
        EscapedCommand: escapedInvalidCommand,
      });
    }

    expect(
      failureLog,
      'Expected failing run_shell_command invocation for invalid syntax',
    ).toBeTruthy();
    expect(failureLog!.toolRequest.success).toBe(false);
    expect(result).not.toContain('offline-disallowed-secret-contents');
  });
});
