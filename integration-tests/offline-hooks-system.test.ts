/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestRig, normalizePath } from './test-helper.js';

describe('Hooks System Integration', { timeout: 120000 }, () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  afterEach(async () => {
    if (rig) {
      await rig.cleanup();
    }
  });

  describe('Command Hooks - Blocking Behavior', () => {
    it('should block tool execution when hook returns block decision', async () => {
      rig.setup(
        'should block tool execution when hook returns block decision',
        {
          fakeResponsesPath: join(
            import.meta.dirname,
            'hooks-system.block-tool.responses',
          ),
        },
      );

      const scriptPath = rig.createScript(
        'block_hook.cjs',
        "console.log(JSON.stringify({decision: 'block', reason: 'File writing blocked by security policy'}));",
      );

      rig.setup(
        'should block tool execution when hook returns block decision',
        {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              BeforeTool: [
                {
                  matcher: 'write_file',
                  sequential: true,
                  hooks: [
                    {
                      type: 'command',
                      command: normalizePath(`node "${scriptPath}"`),
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        },
      );

      const result = await rig.run({
        args: 'Create a file called test.txt with content "Hello World"',
        env: { GEMINI_API_KEY: 'offline-fixture-key' },
      });

      const toolLogs = rig.readToolLogs();
      const writeFileCalls = toolLogs.filter(
        (t) =>
          t.toolRequest.name === 'write_file' && t.toolRequest.success === true,
      );
      expect(writeFileCalls).toHaveLength(0);
      expect(result).toContain('File writing blocked by security policy');

      const hookTelemetryFound = await rig.waitForTelemetryEvent('hook_call');
      expect(hookTelemetryFound).toBeTruthy();
    });

    it('should block tool execution and use stderr as reason when hook exits with code 2', async () => {
      rig.setup(
        'should block tool execution and use stderr as reason when hook exits with code 2',
        {
          fakeResponsesPath: join(
            import.meta.dirname,
            'hooks-system.block-tool.responses',
          ),
        },
      );

      const blockMsg = 'File writing blocked by security policy';
      const scriptPath = rig.createScript(
        'stderr_block_hook.cjs',
        `process.stderr.write(JSON.stringify({ decision: 'deny', reason: '${blockMsg}' })); process.exit(2);`,
      );

      rig.setup(
        'should block tool execution and use stderr as reason when hook exits with code 2',
        {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              BeforeTool: [
                {
                  matcher: 'write_file',
                  sequential: true,
                  hooks: [
                    {
                      type: 'command',
                      command: normalizePath(`node "${scriptPath}"`)!,
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        },
      );

      const result = await rig.run({
        args: 'Create a file called test.txt with content "Hello World"',
        env: { GEMINI_API_KEY: 'offline-fixture-key' },
      });

      const toolLogs = rig.readToolLogs();
      const writeFileCalls = toolLogs.filter(
        (t) =>
          t.toolRequest.name === 'write_file' && t.toolRequest.success === true,
      );
      expect(writeFileCalls).toHaveLength(0);
      expect(result).toContain(blockMsg);

      const hookLogs = rig.readHookLogs();
      const blockHook = hookLogs.find(
        (log) =>
          log.hookCall.hook_event_name === 'BeforeTool' &&
          (log.hookCall.stdout.includes('"decision":"deny"') ||
            log.hookCall.stderr.includes('"decision":"deny"')),
      );
      expect(blockHook).toBeDefined();
      expect(
        (blockHook?.hookCall.stdout || '') + (blockHook?.hookCall.stderr || ''),
      ).toContain(blockMsg);
    });

    it('should allow tool execution when hook returns allow decision', async () => {
      rig.setup(
        'should allow tool execution when hook returns allow decision',
        {
          fakeResponsesPath: join(
            import.meta.dirname,
            'hooks-system.allow-tool.responses',
          ),
        },
      );

      const scriptPath = rig.createScript(
        'allow_hook.cjs',
        "console.log(JSON.stringify({decision: 'allow', reason: 'File writing approved'}));",
      );

      rig.setup(
        'should allow tool execution when hook returns allow decision',
        {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              BeforeTool: [
                {
                  matcher: 'write_file',
                  sequential: true,
                  hooks: [
                    {
                      type: 'command',
                      command: normalizePath(`node "${scriptPath}"`),
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        },
      );

      await rig.run({
        args: 'Create a file called approved.txt with content "Approved content"',
        env: { GEMINI_API_KEY: 'offline-fixture-key' },
      });

      const foundWriteFile = await rig.waitForToolCall('write_file');
      expect(foundWriteFile).toBeTruthy();
      const fileContent = rig.readFile('approved.txt');
      expect(fileContent).toContain('Approved content');
      const hookTelemetryFound = await rig.waitForTelemetryEvent('hook_call');
      expect(hookTelemetryFound).toBeTruthy();
    });
  });

  describe('Command Hooks - Additional Context', () => {
    it('should add additional context from AfterTool hooks', async () => {
      rig.setup('should add additional context from AfterTool hooks', {
        fakeResponsesPath: join(
          import.meta.dirname,
          'hooks-system.after-tool-context.responses',
        ),
      });

      const scriptPath = rig.createScript(
        'after_tool_context.cjs',
        "console.log(JSON.stringify({hookSpecificOutput: {hookEventName: 'AfterTool', additionalContext: 'Security scan: File content appears safe'}}));",
      );

      const command = `node "${scriptPath}"`;
      rig.setup('should add additional context from AfterTool hooks', {
        settings: {
          hooksConfig: { enabled: true },
          hooks: {
            AfterTool: [
              {
                matcher: 'read_file',
                sequential: true,
                hooks: [
                  {
                    type: 'command',
                    command: normalizePath(command),
                    timeout: 5000,
                  },
                ],
              },
            ],
          },
        },
      });

      rig.createFile('test-file.txt', 'This is test content');
      await rig.run({
        args: 'Read the contents of test-file.txt and tell me what it contains',
        env: { GEMINI_API_KEY: 'offline-fixture-key' },
      });

      const foundReadFile = await rig.waitForToolCall('read_file');
      expect(foundReadFile).toBeTruthy();
      const hookTelemetryFound = rig.readHookLogs();
      expect(hookTelemetryFound.length).toBeGreaterThan(0);
      expect(hookTelemetryFound[0].hookCall.hook_event_name).toBe('AfterTool');
      expect(hookTelemetryFound[0].hookCall.hook_name).toBe(
        normalizePath(command),
      );
      expect(hookTelemetryFound[0].hookCall.hook_input).toBeDefined();
      expect(hookTelemetryFound[0].hookCall.hook_output).toBeDefined();
      expect(hookTelemetryFound[0].hookCall.exit_code).toBe(0);
      expect(hookTelemetryFound[0].hookCall.stdout).toBeDefined();
      expect(hookTelemetryFound[0].hookCall.stderr).toBeDefined();
    });
  });

  describe('Command Hooks - Tail Tool Calls', () => {
    it('should execute a tail tool call from AfterTool hooks and replace original response', async () => {
      rig.setup('should execute a tail tool call from AfterTool hooks', {
        fakeResponsesPath: join(
          import.meta.dirname,
          'hooks-system.tail-tool-call.responses',
        ),
      });

      const hookOutput = {
        decision: 'allow',
        hookSpecificOutput: {
          hookEventName: 'AfterTool',
          tailToolCallRequest: {
            name: 'write_file',
            args: {
              file_path: 'tail-called-file.txt',
              content: 'Content from tail call',
            },
          },
        },
      };
      const hookScript = `console.log(JSON.stringify(${JSON.stringify(
        hookOutput,
      )})); process.exit(0);`;
      const scriptPath = join(rig.testDir!, 'tail_call_hook.js');
      writeFileSync(scriptPath, hookScript);
      const commandPath = scriptPath.replace(/\\/g, '/');

      rig.setup('should execute a tail tool call from AfterTool hooks', {
        fakeResponsesPath: join(
          import.meta.dirname,
          'hooks-system.tail-tool-call.responses',
        ),
        settings: {
          hooksConfig: { enabled: true },
          hooks: {
            AfterTool: [
              {
                matcher: 'read_file',
                hooks: [
                  {
                    type: 'command',
                    command: `node "${commandPath}"`,
                    timeout: 5000,
                  },
                ],
              },
            ],
          },
        },
      });

      rig.createFile('original.txt', 'Original content');
      const cliOutput = await rig.run({
        args: 'Read original.txt',
        env: { GEMINI_API_KEY: 'offline-fixture-key' },
      });

      const foundWriteFile = await rig.waitForToolCall('write_file');
      expect(foundWriteFile).toBeTruthy();
      expect(cliOutput).toContain('Tail call completed successfully.');
      await rig.waitForTelemetryReady();

      const hookLogs = rig.readHookLogs();
      const relevantHookLog = hookLogs.find(
        (l) => l.hookCall.hook_event_name === 'AfterTool',
      );
      expect(relevantHookLog).toBeDefined();

      const modifiedContent = rig.readFile('tail-called-file.txt');
      expect(modifiedContent).toBe('Content from tail call');
      const toolLogs = rig.readToolLogs();
      const successfulTools = toolLogs.filter((t) => t.toolRequest.success);
      expect(
        successfulTools.some((t) => t.toolRequest.name === 'write_file'),
      ).toBeTruthy();
    });
  });
});
