/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { TestRig, normalizePath } from './test-helper.js';

describe('Offline Hooks System extra', { timeout: 120000 }, () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  afterEach(async () => {
    await rig.cleanup();
  });

  it('BeforeModel hook replaces the request and returns the replacement response', async () => {
    const name = 'offline BeforeModel replacement';
    rig.setup(name, {
      fakeResponsesPath: join(
        import.meta.dirname,
        'offline-hooks-system-extra.before-model.responses',
      ),
    });
    const scriptPath = rig.createScript(
      'before-model.cjs',
      `console.log(JSON.stringify({decision:'allow',hookSpecificOutput:{hookEventName:'BeforeModel',llm_request:{messages:[{role:'user',content:'Please respond with exactly: The security hook modified this request successfully.'}]}}}));`,
    );
    rig.setup(name, {
      settings: {
        hooksConfig: { enabled: true },
        hooks: {
          BeforeModel: [
            {
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
    });

    const result = await rig.run({
      args: 'Tell me a story',
      env: { GEMINI_API_KEY: 'offline-fixture-key' },
    });

    expect(result).toContain('security hook modified');
    expect(
      rig.readHookLogs().map((log) => log.hookCall.hook_event_name),
    ).toContain('BeforeModel');
  });

  it('AfterModel hook replaces the generated response', async () => {
    const name = 'offline AfterModel response';
    rig.setup(name, {
      fakeResponsesPath: join(
        import.meta.dirname,
        'offline-hooks-system-extra.after-model.responses',
      ),
    });
    const scriptPath = rig.createScript(
      'after-model.cjs',
      `console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'AfterModel',llm_response:{candidates:[{content:{role:'model',parts:['[FILTERED] Response has been filtered for security compliance.']},finishReason:'STOP'}]}}}));`,
    );
    rig.setup(name, {
      settings: {
        hooksConfig: { enabled: true },
        hooks: {
          AfterModel: [
            {
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
    });

    const result = await rig.run({
      args: 'What is 2 + 2?',
      env: { GEMINI_API_KEY: 'offline-fixture-key' },
    });

    expect(result).toContain(
      '[FILTERED] Response has been filtered for security compliance',
    );
    expect(
      rig.readHookLogs().map((log) => log.hookCall.hook_event_name),
    ).toContain('AfterModel');
  });

  it('BeforeToolSelection constrains available tools to read_file', async () => {
    const name = 'offline BeforeToolSelection';
    rig.setup(name, {
      fakeResponsesPath: join(
        import.meta.dirname,
        'offline-hooks-system-extra.before-tool-selection.responses',
      ),
    });
    const scriptPath = rig.createScript(
      'tool-selection.cjs',
      `console.log(JSON.stringify({decision:'allow',hookSpecificOutput:{hookEventName:'BeforeToolSelection',toolConfig:{mode:'ANY',allowedFunctionNames:['read_file']}}}));`,
    );
    rig.setup(name, {
      settings: {
        hooksConfig: { enabled: true },
        hooks: {
          BeforeToolSelection: [
            {
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
    });
    rig.createFile('new_file_data.txt', 'test data');

    await rig.run({
      args: 'Check the content of new_file_data.txt',
      env: { GEMINI_API_KEY: 'offline-fixture-key' },
    });

    expect(
      rig
        .readToolLogs()
        .some(
          (log) =>
            log.toolRequest.name === 'read_file' && log.toolRequest.success,
        ),
    ).toBe(true);
    expect(
      rig.readHookLogs().map((log) => log.hookCall.hook_event_name),
    ).toContain('BeforeToolSelection');
  });

  it('runs sequential BeforeAgent hooks in configured order', async () => {
    const name = 'offline sequential hooks';
    rig.setup(name, {
      fakeResponsesPath: join(
        import.meta.dirname,
        'offline-hooks-system-extra.sequential-execution.responses',
      ),
    });
    const first = rig.createScript(
      'first.cjs',
      `console.log(JSON.stringify({decision:'allow',hookSpecificOutput:{hookEventName:'BeforeAgent',additionalContext:'FIRST_SEQUENCE_MARKER'}}));`,
    );
    const second = rig.createScript(
      'second.cjs',
      `console.log(JSON.stringify({decision:'allow',hookSpecificOutput:{hookEventName:'BeforeAgent',additionalContext:'SECOND_SEQUENCE_MARKER'}}));`,
    );
    rig.setup(name, {
      settings: {
        hooksConfig: { enabled: true },
        hooks: {
          BeforeAgent: [
            {
              sequential: true,
              hooks: [first, second].map((scriptPath) => ({
                type: 'command',
                command: normalizePath(`node "${scriptPath}"`),
                timeout: 5000,
              })),
            },
          ],
        },
      },
    });

    await rig.run({
      args: 'Hello, help me with a task',
      env: { GEMINI_API_KEY: 'offline-fixture-key' },
    });

    const logs = rig
      .readHookLogs()
      .filter((log) => log.hookCall.hook_event_name === 'BeforeAgent');
    expect(
      logs.map(
        (log) =>
          log.hookCall.stdout.match(/(?:FIRST|SECOND)_SEQUENCE_MARKER/)?.[0],
      ),
    ).toEqual(['FIRST_SEQUENCE_MARKER', 'SECOND_SEQUENCE_MARKER']);
  });

  it('passes structured tool input to a BeforeTool validation hook', async () => {
    const name = 'offline hook input validation';
    rig.setup(name, {
      fakeResponsesPath: join(
        import.meta.dirname,
        'offline-hooks-system-extra.input-validation.responses',
      ),
    });
    const scriptPath = rig.createScript(
      'validate-input.cjs',
      `const input=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(JSON.stringify({decision:input.session_id&&input.cwd&&input.hook_event_name&&input.timestamp&&input.tool_name&&input.tool_input?'allow':'block',reason:'validation result'}));`,
    );
    rig.setup(name, {
      settings: {
        hooksConfig: { enabled: true },
        hooks: {
          BeforeTool: [
            {
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
    });

    await rig.run({
      args: 'Create a file called input-test.txt with content "test"',
      env: { GEMINI_API_KEY: 'offline-fixture-key' },
    });

    expect(rig.readFile('input-test.txt')).toBe('test');
    expect(rig.readHookLogs()[0].hookCall.exit_code).toBe(0);
  });

  it('keeps a failed hook from preventing the model response', async () => {
    const name = 'offline hook failure handling';
    rig.setup(name, {
      fakeResponsesPath: join(
        import.meta.dirname,
        'offline-hooks-system-extra.error-handling.responses',
      ),
    });
    const failingPath = rig.createScript(
      'failing-hook.cjs',
      `process.exit(1);`,
    );
    const succeedingPath = rig.createScript(
      'succeeding-hook.cjs',
      `console.log(JSON.stringify({decision:'allow',reason:'SECOND_HOOK_RAN'}));`,
    );
    rig.setup(name, {
      settings: {
        hooksConfig: { enabled: true },
        hooks: {
          BeforeTool: [
            {
              matcher: 'write_file',
              hooks: [failingPath, succeedingPath].map((scriptPath) => ({
                type: 'command',
                command: normalizePath(`node "${scriptPath}"`),
                timeout: 5000,
              })),
            },
          ],
        },
      },
    });

    await rig.run({
      args: 'Create a file called error-test.txt with content "testing error handling"',
      env: { GEMINI_API_KEY: 'offline-fixture-key' },
    });

    expect(rig.readFile('error-test.txt')).toContain('testing error handling');
    expect(rig.readHookLogs().map((log) => log.hookCall.exit_code)).toEqual([
      1, 0,
    ]);
  });

  it('fires SessionStart with startup source and hook context', async () => {
    const name = 'offline SessionStart context';
    rig.setup(name, {
      fakeResponsesPath: join(
        import.meta.dirname,
        'offline-hooks-system-extra.session-startup.responses',
      ),
    });
    const scriptPath = rig.createScript(
      'session-start.cjs',
      `console.log(JSON.stringify({decision:'allow',systemMessage:'SESSION_START_EXTRA_MARKER'}));`,
    );
    rig.setup(name, {
      settings: {
        hooksConfig: { enabled: true },
        hooks: {
          SessionStart: [
            {
              matcher: 'startup',
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
    });

    await rig.run({
      args: 'Say hello',
      env: { GEMINI_API_KEY: 'offline-fixture-key' },
    });

    const log = rig
      .readHookLogs()
      .find((entry) => entry.hookCall.hook_event_name === 'SessionStart');
    expect(log).toBeDefined();
    expect(log?.hookCall.stdout).toContain('SESSION_START_EXTRA_MARKER');
    expect(JSON.parse(String(log?.hookCall.hook_input)).source).toBe('startup');
  });

  it('fires SessionEnd on non-interactive exit with exit reason', async () => {
    const name = 'offline SessionEnd';
    rig.setup(name, {
      fakeResponsesPath: join(
        import.meta.dirname,
        'offline-hooks-system-extra.session-startup.responses',
      ),
    });
    const scriptPath = rig.createScript(
      'session-end.cjs',
      `console.log(JSON.stringify({decision:'allow',systemMessage:'SESSION_END_EXTRA_MARKER'}));`,
    );
    rig.setup(name, {
      settings: {
        hooksConfig: { enabled: true },
        hooks: {
          SessionEnd: [
            {
              matcher: 'exit',
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
    });

    await rig.run({
      args: 'Hello',
      env: { GEMINI_API_KEY: 'offline-fixture-key' },
    });

    const log = rig
      .readHookLogs()
      .find((entry) => entry.hookCall.hook_event_name === 'SessionEnd');
    expect(log?.hookCall.stdout).toContain('SESSION_END_EXTRA_MARKER');
    expect(JSON.parse(String(log?.hookCall.hook_input)).reason).toBe('exit');
  });

  it('does not execute a hook disabled in settings', async () => {
    const name = 'offline disabled hook';
    rig.setup(name, {
      fakeResponsesPath: join(
        import.meta.dirname,
        'offline-hooks-system-extra.disabled-via-settings.responses',
      ),
    });
    const enabled = rig.createScript(
      'enabled.cjs',
      `console.log(JSON.stringify({decision:'allow',systemMessage:'ENABLED_EXTRA_MARKER'}));`,
    );
    const disabled = rig.createScript(
      'disabled.cjs',
      `console.log(JSON.stringify({decision:'block',reason:'DISABLED_EXTRA_MARKER'}));`,
    );
    rig.setup(name, {
      settings: {
        hooksConfig: { enabled: true, disabled: ['extra-disabled'] },
        hooks: {
          BeforeTool: [
            {
              hooks: [
                {
                  type: 'command',
                  name: 'extra-enabled',
                  command: normalizePath(`node "${enabled}"`),
                  timeout: 5000,
                },
                {
                  type: 'command',
                  name: 'extra-disabled',
                  command: normalizePath(`node "${disabled}"`),
                  timeout: 5000,
                },
              ],
            },
          ],
        },
      },
    });

    await rig.run({
      args: 'Create a file called disabled-test.txt with content "test"',
      env: { GEMINI_API_KEY: 'offline-fixture-key' },
    });

    const logs = rig.readHookLogs();
    expect(
      logs.some((entry) =>
        entry.hookCall.stdout.includes('ENABLED_EXTRA_MARKER'),
      ),
    ).toBe(true);
    expect(
      logs.some((entry) =>
        entry.hookCall.stdout.includes('DISABLED_EXTRA_MARKER'),
      ),
    ).toBe(false);
    expect(rig.readFile('disabled-test.txt')).toContain('test');
  });

  it('overrides BeforeTool input and creates only the overridden path', async () => {
    const name = 'offline BeforeTool input override';
    rig.setup(name, {
      fakeResponsesPath: join(
        import.meta.dirname,
        'offline-hooks-system-extra.input-modification.responses',
      ),
    });
    const scriptPath = rig.createScript(
      'input-override.cjs',
      `console.log(JSON.stringify({decision:'allow',hookSpecificOutput:{hookEventName:'BeforeTool',tool_input:{file_path:'modified.txt',content:'modified content'}}}));`,
    );
    rig.setup(name, {
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
    });

    await rig.run({
      args: 'Create a file called original.txt with content "original content"',
      env: { GEMINI_API_KEY: 'offline-fixture-key' },
    });

    expect(rig.readFile('modified.txt')).toBe('modified content');
    expect(
      rig
        .readToolLogs()
        .map((log) => JSON.parse(log.toolRequest.args).file_path),
    ).toEqual(['modified.txt']);
  });

  it('stops agent execution when BeforeTool returns a stop decision', async () => {
    const name = 'offline BeforeTool stop';
    rig.setup(name, {
      fakeResponsesPath: join(
        import.meta.dirname,
        'offline-hooks-system-extra.before-tool-stop.responses',
      ),
    });
    const scriptPath = rig.createScript(
      'before-tool-stop.cjs',
      `console.log(JSON.stringify({continue:false,reason:'EXTRA_STOP_MARKER',hookSpecificOutput:{hookEventName:'BeforeTool'}}));`,
    );
    rig.setup(name, {
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
    });

    const result = await rig.run({
      args: 'Create a file called stopped.txt with content "blocked"',
      env: { GEMINI_API_KEY: 'offline-fixture-key' },
    });

    expect(result).toContain(
      'Agent execution stopped by hook: EXTRA_STOP_MARKER',
    );
    expect(
      rig
        .readToolLogs()
        .filter(
          (log) =>
            log.toolRequest.name === 'write_file' && log.toolRequest.success,
        ),
    ).toHaveLength(0);
  });
});
