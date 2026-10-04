/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { parse as shellParse } from 'shell-quote';
import {
  extractStringFromParseEntry,
  initializeShellParsers,
  splitCommands,
  stripShellWrapper,
} from '../../utils/shell-utils.js';

/**
 * Determines if a command is strictly approved for execution on Windows.
 * A command is approved if it's composed entirely of tools explicitly listed in `approvedTools`
 * OR if it's composed of known safe, read-only Windows commands.
 *
 * @param command - The full command string to execute.
 * @param args - The arguments for the command.
 * @param approvedTools - A list of explicitly approved tool names (e.g., ['npm', 'git']).
 * @returns true if the command is strictly approved, false otherwise.
 */
export async function isStrictlyApproved(
  command: string,
  args: string[],
  approvedTools?: string[],
): Promise<boolean> {
  const tools = approvedTools ?? [];

  await initializeShellParsers();

  const fullCmd = [command, ...args].join(' ');
  const stripped = stripShellWrapper(fullCmd);

  const pipelineCommands = splitCommands(stripped);

  // Fallback for simple commands or parsing failures
  if (pipelineCommands.length === 0) {
    return tools.includes(command) || isKnownSafeCommand([command, ...args]);
  }

  // Check every segment of the pipeline
  return pipelineCommands.every((cmdString) => {
    const trimmed = cmdString.trim();
    if (!trimmed) return true;

    const parsedArgs = shellParse(trimmed).map(extractStringFromParseEntry);
    if (parsedArgs.length === 0) return true;

    let root = parsedArgs[0].toLowerCase();
    if (root.endsWith('.exe')) {
      root = root.slice(0, -4);
    }
    // The segment is approved if the root tool is in the allowlist OR if the whole segment is safe.
    return (
      tools.some((t) => t.toLowerCase() === root) ||
      isKnownSafeCommand(parsedArgs)
    );
  });
}

/**
 * Checks if a Windows command is known to be safe (read-only).
 */
export function isKnownSafeCommand(args: string[]): boolean {
  if (!args || args.length === 0) return false;
  let cmd = args[0].toLowerCase();
  if (cmd.endsWith('.exe')) {
    cmd = cmd.slice(0, -4);
  }

  // Native Windows/PowerShell safe commands
  const safeCommands = new Set([
    '__read',
    '__write',
    'dir',
    'type',
    'echo',
    'cd',
    'pwd',
    'whoami',
    'hostname',
    'ver',
    'vol',
    'systeminfo',
    'attrib',
    'findstr',
    'where',
    'sort',
    'more',
    'get-childitem',
    'get-content',
    'get-location',
    'get-help',
    'get-process',
    'get-service',
    'get-eventlog',
    'select-string',
    // Read-only pipeline transforms used by the CLI's supported PowerShell
    // query wrapper; keep them safe when the wrapper is classified cross-platform.
    'group-object',
    'sort-object',
    'format-table',
  ]);

  if (safeCommands.has(cmd)) {
    return true;
  }

  // We allow git on Windows if it's read-only, using the same logic as POSIX
  if (cmd === 'git') {
    // For simplicity in this branch, we'll allow standard git read operations
    // In a full implementation, we'd port the sub-command validation too.
    const sub = args[1]?.toLowerCase();
    return ['status', 'log', 'diff', 'show', 'branch'].includes(sub);
  }

  return false;
}

/**
 * Absolute, non-overridable denials for Windows — return true even in YOLO
 * mode. Mirrors the POSIX circuit breaker: catastrophic, almost-never-
 * intentional patterns (wipe a whole drive, format the system volume,
 * delete volume shadow copies used for backup/recovery).
 */
export function isCircuitBreakerCommand(args: string[]): boolean {
  if (!args || args.length === 0) return false;
  let cmd = args[0].toLowerCase();
  if (cmd.endsWith('.exe')) {
    cmd = cmd.slice(0, -4);
  }
  const rest = args.slice(1).map((a) => a.toLowerCase());

  if (
    cmd === 'format' &&
    rest.some((a) => /^[a-z]:\\?$/.test(a) || a === 'c:')
  ) {
    return true;
  }

  if (
    (cmd === 'rd' ||
      cmd === 'rmdir' ||
      cmd === 'del' ||
      cmd === 'erase' ||
      cmd === 'remove-item') &&
    rest.some((a) => /^[a-z]:\\?$/.test(a) || a === '\\' || a === '/')
  ) {
    return true;
  }

  // vssadmin delete shadows /all destroys all restore points/backups
  if (cmd === 'vssadmin' && rest[0] === 'delete' && rest[1] === 'shadows') {
    return true;
  }

  return false;
}

/**
 * Legacy, narrower dangerous-command check for Windows, retained for
 * approval modes that predate the broadened Auto-mode heuristics (DEFAULT).
 */
export function isDangerousCommandLegacy(args: string[]): boolean {
  if (!args || args.length === 0) return false;
  let cmd = args[0].toLowerCase();
  if (cmd.endsWith('.exe')) {
    cmd = cmd.slice(0, -4);
  }

  const dangerous = new Set([
    'del',
    'erase',
    'rd',
    'rmdir',
    'net',
    'reg',
    'sc',
    'format',
    'mklink',
    'takeown',
    'icacls',
    'powershell',
    'pwsh',
    'cmd',
    'remove-item',
    'stop-process',
    'stop-service',
    'set-item',
    'new-item',
  ]);

  return dangerous.has(cmd);
}

/**
 * Checks if a Windows command is explicitly dangerous.
 *
 * @param strict - When false, only applies the legacy narrower rule set
 *   (pre-Auto-mode behavior) instead of the full broadened check.
 */
export function isDangerousCommand(args: string[], strict = true): boolean {
  if (!args || args.length === 0) return false;
  if (isCircuitBreakerCommand(args)) return true;
  if (!strict) return isDangerousCommandLegacy(args);
  let cmd = args[0].toLowerCase();
  if (cmd.endsWith('.exe')) {
    cmd = cmd.slice(0, -4);
  }
  const rest = args.slice(1).map((a) => a.toLowerCase());

  // Process/task killing can terminate the agent's own session or services
  if (cmd === 'taskkill' && rest.includes('/f')) {
    return true;
  }

  // wmic <alias> delete can bulk-delete processes, shares, startup entries, etc.
  if (cmd === 'wmic' && rest.includes('delete')) {
    return true;
  }

  // vssadmin (any subcommand touching shadow copies) is destructive to backups
  if (cmd === 'vssadmin') {
    return true;
  }

  // fsutil can zero/delete files and manipulate volume-level file data
  if (cmd === 'fsutil') {
    return true;
  }

  // Clears the Recycle Bin (permanent, unrecoverable deletion)
  if (cmd === 'clear-recyclebin') {
    return true;
  }

  // wevtutil cl clears event logs — anti-forensic / destroys audit trail
  if (cmd === 'wevtutil' && rest[0] === 'cl') {
    return true;
  }

  // Loosens PowerShell's script execution safety net for the whole machine
  if (cmd === 'set-executionpolicy') {
    return true;
  }

  // Deletes a local/domain user account
  if (cmd === 'net' && rest[0] === 'user' && rest.includes('/delete')) {
    return true;
  }

  const dangerous = new Set([
    'del',
    'erase',
    'rd',
    'rmdir',
    'rm',
    'unlink',
    'net',
    'reg',
    'sc',
    'format',
    'mklink',
    'takeown',
    'icacls',
    'powershell', // prevent shell escapes
    'pwsh',
    'cmd',
    'remove-item',
    'stop-process',
    'stop-service',
    'set-item',
    'new-item',
    'move-item',
    'copy-item',
    'rename-item',
    'clear-content',
    'clear-item',
    'set-content',
    'add-content',
    'out-file',
    'start-process',
    'invoke-expression',
    'iex',
    'shutdown',
    'diskpart',
    'bcdedit',
    'cipher',
    'attrib',
    'cacls',
    'sdelete',
  ]);

  if (dangerous.has(cmd)) {
    return true;
  }

  // Protect writes/moves into Windows system directories
  if (
    cmd === 'move' ||
    cmd === 'copy' ||
    cmd === 'xcopy' ||
    cmd === 'robocopy'
  ) {
    const targets = args
      .slice(1)
      .filter((a) => !a.startsWith('/') && !a.startsWith('-'));
    if (targets.length > 0) {
      const dest = targets[targets.length - 1].replace(/\\/g, '/');
      const systemPrefixes = [
        'C:/Windows',
        'C:/Program Files',
        'C:/Program Files (x86)',
        '/Windows',
        '/Program Files',
      ];
      if (
        systemPrefixes.some(
          (prefix) =>
            dest.toLowerCase() === prefix.toLowerCase() ||
            dest.toLowerCase().startsWith(prefix.toLowerCase() + '/'),
        )
      ) {
        return true;
      }
    }
  }

  return false;
}
