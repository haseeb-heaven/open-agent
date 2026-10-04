/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { LinuxSandboxManager } from '../sandbox/linux/LinuxSandboxManager.js';
import { ApprovalMode, PolicyDecision } from './types.js';
import { PolicyEngine } from './policy-engine.js';

describe('PowerShell command safety across host platforms', () => {
  const createEngine = (approvalMode = ApprovalMode.AUTO) =>
    new PolicyEngine({
      approvalMode,
      defaultDecision: PolicyDecision.ALLOW,
      sandboxManager: new LinuxSandboxManager({ workspace: process.cwd() }),
    });

  const check = (engine: PolicyEngine, command: string) =>
    engine.check({ name: 'run_shell_command', args: { command } }, undefined);

  it('allows a safe PowerShell command pipeline in Auto mode', async () => {
    const engine = createEngine();
    const command =
      'powershell -NoProfile -NonInteractive -Command "Get-ChildItem -Filter *.qvm -Recurse | Group-Object Extension | Sort-Object Count | Format-Table"';

    await expect(check(engine, command)).resolves.toMatchObject({
      decision: PolicyDecision.ALLOW,
    });
  });

  it('asks before a destructive PowerShell cmdlet inside -Command', async () => {
    const engine = createEngine();
    const command =
      'powershell -NoProfile -NonInteractive -Command "Remove-Item -Recurse -Force C:\\Windows\\System32"';

    await expect(check(engine, command)).resolves.toMatchObject({
      decision: PolicyDecision.ASK_USER,
    });
  });

  it('asks when a destructive cmdlet appears after a safe pipeline segment', async () => {
    const engine = createEngine();
    const command =
      'pwsh -NoProfile -NonInteractive -Command "Get-ChildItem -Path . | Remove-Item -Recurse -Force"';

    await expect(check(engine, command)).resolves.toMatchObject({
      decision: PolicyDecision.ASK_USER,
    });
  });

  it('asks for opaque encoded PowerShell commands in Auto mode', async () => {
    const engine = createEngine();
    const command = 'powershell -NoProfile -EncodedCommand SQBFAFgA';

    await expect(check(engine, command)).resolves.toMatchObject({
      decision: PolicyDecision.ASK_USER,
    });
  });

  it('asks before opaque encoded commands in YOLO mode', async () => {
    const engine = createEngine(ApprovalMode.YOLO);

    await expect(
      check(engine, 'pwsh -EncodedCommand SQBFAFgA'),
    ).resolves.toMatchObject({ decision: PolicyDecision.ASK_USER });
  });

  it('asks for unrecognized PowerShell invocation forms in Auto mode', async () => {
    const engine = createEngine();

    await expect(
      check(engine, 'pwsh -c "Get-ChildItem . | Remove-Item -Recurse -Force"'),
    ).resolves.toMatchObject({ decision: PolicyDecision.ASK_USER });
    await expect(
      check(engine, 'pwsh Get-ChildItem . | Remove-Item -Recurse -Force'),
    ).resolves.toMatchObject({ decision: PolicyDecision.ASK_USER });
  });

  it('asks before invoking unknown executables in a PowerShell script', async () => {
    const engine = createEngine();

    await expect(
      check(engine, 'pwsh -Command "curl.exe https://example.invalid"'),
    ).resolves.toMatchObject({ decision: PolicyDecision.ASK_USER });
  });

  it('keeps YOLO behavior for ordinary dangerous commands but not circuit breakers', async () => {
    const engine = createEngine(ApprovalMode.YOLO);

    await expect(
      check(engine, 'powershell -Command "Remove-Item -Force file.txt"'),
    ).resolves.toMatchObject({ decision: PolicyDecision.ALLOW });
    await expect(
      check(engine, 'powershell -Command "Remove-Item -Recurse -Force C:\\"'),
    ).resolves.toMatchObject({ decision: PolicyDecision.ASK_USER });
  });

  it('does not broaden the legacy DEFAULT decision for PowerShell commands', async () => {
    const engine = createEngine(ApprovalMode.DEFAULT);

    await expect(
      check(engine, 'powershell -Command "Remove-Item -Force file.txt"'),
    ).resolves.toMatchObject({ decision: PolicyDecision.ALLOW });
  });
});
