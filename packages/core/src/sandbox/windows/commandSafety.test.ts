/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  isKnownSafeCommand,
  isDangerousCommand,
  isCircuitBreakerCommand,
} from './commandSafety.js';

describe('Windows commandSafety', () => {
  describe('isKnownSafeCommand', () => {
    it('should identify known safe commands', () => {
      expect(isKnownSafeCommand(['dir'])).toBe(true);
      expect(isKnownSafeCommand(['echo', 'hello'])).toBe(true);
      expect(isKnownSafeCommand(['whoami'])).toBe(true);
      expect(isKnownSafeCommand(['Group-Object', 'Extension'])).toBe(true);
      expect(isKnownSafeCommand(['Sort-Object', 'Count'])).toBe(true);
      expect(isKnownSafeCommand(['Format-Table'])).toBe(true);
    });

    it('should strip .exe extension for safe commands', () => {
      expect(isKnownSafeCommand(['dir.exe'])).toBe(true);
      expect(isKnownSafeCommand(['ECHO.EXE', 'hello'])).toBe(true);
      expect(isKnownSafeCommand(['WHOAMI.exe'])).toBe(true);
    });

    it('should reject unknown commands', () => {
      expect(isKnownSafeCommand(['unknown'])).toBe(false);
      expect(isKnownSafeCommand(['npm', 'install'])).toBe(false);
    });
  });

  describe('isDangerousCommand', () => {
    it('should identify dangerous commands', () => {
      expect(isDangerousCommand(['del', 'file.txt'])).toBe(true);
      expect(isDangerousCommand(['powershell', '-Command', 'echo'])).toBe(true);
      expect(isDangerousCommand(['cmd', '/c', 'dir'])).toBe(true);
    });

    it('should strip .exe extension for dangerous commands', () => {
      expect(isDangerousCommand(['del.exe', 'file.txt'])).toBe(true);
      expect(isDangerousCommand(['POWERSHELL.EXE', '-Command', 'echo'])).toBe(
        true,
      );
      expect(isDangerousCommand(['cmd.exe', '/c', 'dir'])).toBe(true);
    });

    it('should not flag safe commands as dangerous', () => {
      expect(isDangerousCommand(['dir'])).toBe(false);
      expect(isDangerousCommand(['echo', 'hello'])).toBe(false);
    });
  });

  describe('isCircuitBreakerCommand (absolute denial, cannot be overridden)', () => {
    it('should flag format on a drive root', () => {
      expect(isCircuitBreakerCommand(['format', 'C:'])).toBe(true);
      expect(isCircuitBreakerCommand(['format', 'C:\\'])).toBe(true);
    });

    it('should flag del/rd/rmdir/remove-item on a drive root', () => {
      expect(isCircuitBreakerCommand(['rd', '/s', '/q', 'C:\\'])).toBe(true);
      expect(isCircuitBreakerCommand(['del', 'C:\\'])).toBe(true);
      expect(isCircuitBreakerCommand(['Remove-Item', 'C:\\'])).toBe(true);
    });

    it('should NOT flag del/rd on a normal path', () => {
      expect(isCircuitBreakerCommand(['del', 'C:\\temp\\file.txt'])).toBe(
        false,
      );
      expect(isCircuitBreakerCommand(['rd', '/s', 'C:\\temp'])).toBe(false);
    });

    it('should flag vssadmin delete shadows', () => {
      expect(isCircuitBreakerCommand(['vssadmin', 'delete', 'shadows'])).toBe(
        true,
      );
    });

    it('should return false for empty or benign commands', () => {
      expect(isCircuitBreakerCommand([])).toBe(false);
      expect(isCircuitBreakerCommand(['dir'])).toBe(false);
      expect(isCircuitBreakerCommand(['echo', 'hello'])).toBe(false);
    });

    it('should be checked first inside isDangerousCommand', () => {
      expect(isDangerousCommand(['format', 'C:'])).toBe(true);
    });
  });

  describe('isDangerousCommand: newly-expanded patterns', () => {
    it('should flag taskkill /F', () => {
      expect(isDangerousCommand(['taskkill', '/F', '/IM', 'node.exe'])).toBe(
        true,
      );
    });

    it('should flag wmic delete', () => {
      expect(
        isDangerousCommand(['wmic', 'process', 'where', 'name="x"', 'delete']),
      ).toBe(true);
    });

    it('should flag bare vssadmin', () => {
      expect(isDangerousCommand(['vssadmin', 'list', 'shadows'])).toBe(true);
    });

    it('should flag fsutil, Clear-RecycleBin, wevtutil cl, Set-ExecutionPolicy', () => {
      expect(isDangerousCommand(['fsutil', 'file', 'setzerodata'])).toBe(true);
      expect(isDangerousCommand(['Clear-RecycleBin'])).toBe(true);
      expect(isDangerousCommand(['wevtutil', 'cl', 'System'])).toBe(true);
      expect(isDangerousCommand(['Set-ExecutionPolicy', 'Unrestricted'])).toBe(
        true,
      );
    });

    it('should flag net user /delete', () => {
      expect(isDangerousCommand(['net', 'user', 'bob', '/delete'])).toBe(true);
    });
  });

  describe('isDangerousCommand with strict=false (legacy DEFAULT rule set)', () => {
    it('should still flag the original dangerous command list', () => {
      expect(isDangerousCommand(['del', 'file.txt'], false)).toBe(true);
      expect(
        isDangerousCommand(['powershell', '-Command', 'echo'], false),
      ).toBe(true);
      expect(isDangerousCommand(['cmd', '/c', 'dir'], false)).toBe(true);
    });

    it('should not flag the newly-expanded patterns', () => {
      expect(
        isDangerousCommand(['taskkill', '/F', '/IM', 'node.exe'], false),
      ).toBe(false);
      expect(
        isDangerousCommand(
          ['wmic', 'process', 'where', 'name="x"', 'delete'],
          false,
        ),
      ).toBe(false);
      expect(isDangerousCommand(['vssadmin', 'list', 'shadows'], false)).toBe(
        false,
      );
      expect(isDangerousCommand(['net', 'user', 'bob', '/delete'], false)).toBe(
        true,
      );
    });

    it('should still be overridden by the circuit breaker', () => {
      expect(isDangerousCommand(['format', 'C:'], false)).toBe(true);
    });
  });
});
