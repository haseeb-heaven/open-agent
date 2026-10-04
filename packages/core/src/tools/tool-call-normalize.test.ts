/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  looksLikeFileGlobPattern,
  isGlobShapedSearchArgs,
  normalizeToolCallRequest,
  extractHttpUrlFromArgs,
  resolveDownloadDest,
  looksLikeDirectoryPath,
  buildDownloadShellCommand,
} from './tool-call-normalize.js';
import {
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  SHELL_TOOL_NAME,
} from './tool-names.js';

describe('download path helpers', () => {
  it('extracts http URL from free-form args', () => {
    expect(
      extractHttpUrlFromArgs({ query: 'web: https://example.com/a.zip?x=1' }),
    ).toBe('https://example.com/a.zip?x=1');
    expect(extractHttpUrlFromArgs({ url: 'https://cdn.test/file.bin' })).toBe(
      'https://cdn.test/file.bin',
    );
  });

  it('detects directory vs file destinations', () => {
    expect(looksLikeDirectoryPath('C:/Users/Downloads/')).toBe(true);
    expect(looksLikeDirectoryPath('C:/Users/Downloads')).toBe(true);
    expect(looksLikeDirectoryPath('C:/Users/Downloads/app.exe')).toBe(false);
  });

  it('joins filename from URL onto directory destinations', () => {
    expect(resolveDownloadDest('https://ex.com/path/pkg.zip', 'D:/tmp/')).toBe(
      'D:/tmp/pkg.zip',
    );
    expect(
      resolveDownloadDest('https://ex.com/path/pkg.zip', 'D:/tmp/out.zip'),
    ).toBe('D:/tmp/out.zip');
  });

  it('builds a platform shell download command', () => {
    const cmd = buildDownloadShellCommand(
      'https://ex.com/f.bin',
      'D:/tmp/f.bin',
    );
    expect(cmd).toMatch(/Invoke-WebRequest|curl /);
    expect(cmd).toContain('https://ex.com/f.bin');
  });
});

describe('looksLikeFileGlobPattern', () => {
  it('detects extension globs', () => {
    expect(looksLikeFileGlobPattern('*.*')).toBe(true);
    expect(looksLikeFileGlobPattern('*.txt')).toBe(true);
    expect(looksLikeFileGlobPattern('**/*.md')).toBe(true);
    expect(looksLikeFileGlobPattern('src/**/*.ts')).toBe(true);
  });

  it('rejects normal content regexes', () => {
    expect(looksLikeFileGlobPattern('TODO|FIXME')).toBe(false);
    expect(looksLikeFileGlobPattern('model id')).toBe(false);
    expect(looksLikeFileGlobPattern('function\\s+foo')).toBe(false);
  });
});

describe('isGlobShapedSearchArgs', () => {
  it('detects FindFiles-style args misrouted to SearchText', () => {
    expect(
      isGlobShapedSearchArgs({
        pattern: '*.*',
        dir_path: 'D:/Code/open-agent',
        case_sensitive: false,
        respect_git_ignore: true,
        respect_gemini_ignore: true,
      }),
    ).toBe(true);
  });

  it('does not treat real grep args as glob-shaped', () => {
    expect(
      isGlobShapedSearchArgs({
        pattern: 'TODO',
        include_pattern: '*.ts',
      }),
    ).toBe(false);
  });
});

describe('normalizeToolCallRequest', () => {
  it('remaps SearchText + glob pattern to glob', () => {
    const result = normalizeToolCallRequest('SearchText', {
      pattern: '*.*',
      dir_path: '.',
      case_sensitive: false,
      respect_git_ignore: true,
      respect_gemini_ignore: true,
    });
    expect(result.name).toBe(GLOB_TOOL_NAME);
    expect(result.remappedFrom).toBe(GREP_TOOL_NAME);
    // dir_path from grep-shaped calls is remapped to glob's `path` param
    expect(result.args).toEqual({
      pattern: '*.*',
      path: '.',
      case_sensitive: false,
      respect_git_ignore: true,
      respect_gemini_ignore: true,
    });
  });

  it('remaps grep_search with bare extension glob to glob', () => {
    const result = normalizeToolCallRequest('grep_search', {
      pattern: '**/*.txt',
    });
    expect(result.name).toBe(GLOB_TOOL_NAME);
    expect((result.args as { pattern: string }).pattern).toBe('**/*.txt');
  });

  it('keeps real content search on grep', () => {
    const result = normalizeToolCallRequest('SearchText', {
      pattern: 'model id',
      include_pattern: '*.md',
    });
    expect(result.name).toBe(GREP_TOOL_NAME);
  });

  it('still recovers generic_tool shell calls', () => {
    const result = normalizeToolCallRequest('generic_tool', {
      command: 'Get-Date',
      description: 'date',
    });
    expect(result.name).toBe(SHELL_TOOL_NAME);
  });

  it('resolves FindFiles display name to glob', () => {
    const result = normalizeToolCallRequest('FindFiles', {
      pattern: '**/*.{txt,md}',
    });
    expect(result.name).toBe(GLOB_TOOL_NAME);
  });

  it('maps path → dir_path for list_directory', () => {
    const result = normalizeToolCallRequest('list_directory', {
      path: 'scratch/live_user',
    });
    expect(result.name).toBe('list_directory');
    expect((result.args as { dir_path: string }).dir_path).toBe(
      'scratch/live_user',
    );
  });

  it('defaults list_directory dir_path to . when empty', () => {
    const result = normalizeToolCallRequest('list_directory', {});
    expect((result.args as { dir_path: string }).dir_path).toBe('.');
  });

  it('maps path → file_path for read_file', () => {
    const result = normalizeToolCallRequest('read_file', {
      path: 'README.md',
    });
    expect((result.args as { file_path: string }).file_path).toBe('README.md');
  });

  it('maps cmd → command for shell', () => {
    const result = normalizeToolCallRequest('run_shell_command', {
      cmd: 'Get-Date',
    });
    expect((result.args as { command: string }).command).toBe('Get-Date');
  });

  it('maps q/search → query for google_web_search', () => {
    const result = normalizeToolCallRequest('google_web_search', {
      q: 'example search topic',
    });
    expect((result.args as { query: string }).query).toBe(
      'example search topic',
    );

    const result2 = normalizeToolCallRequest('WebSearch', {
      search: 'another user question',
    });
    expect((result2.args as { query: string }).query).toBe(
      'another user question',
    );
  });

  it('recovers empty web_search query from last user text (verbatim)', () => {
    const userSaid = 'find docs about whatever the user actually typed';
    const result = normalizeToolCallRequest(
      'google_web_search',
      {},
      { lastUserText: userSaid },
    );
    expect((result.args as { query: string }).query).toBe(userSaid);
  });

  it('remaps WebFetch {url, download_location} to shell download command', () => {
    const result = normalizeToolCallRequest('WebFetch', {
      query: 'web: https://example.com/doc.pdf',
      download_location: 'C:/Users/Downloads/',
    });
    expect(result.name).toBe(SHELL_TOOL_NAME);
    expect(result.remappedFrom).toBe('web_fetch');
    const command = (result.args as { command: string }).command;
    expect(command).toContain('https://example.com/doc.pdf');
    expect(command).toMatch(/doc\.pdf/);
    expect(command).toMatch(/Invoke-WebRequest|curl /);
  });

  it('remaps invented download tool with url + save_path to shell', () => {
    const result = normalizeToolCallRequest('download', {
      url: 'https://cdn.example.org/pkg.zip',
      save_path: 'D:/tmp/pkg.zip',
    });
    expect(result.name).toBe(SHELL_TOOL_NAME);
    const command = (result.args as { command: string }).command;
    expect(command).toContain('https://cdn.example.org/pkg.zip');
    expect(command).toContain('D:/tmp/pkg.zip');
  });

  it('maps web_fetch url field to prompt when not downloading', () => {
    const result = normalizeToolCallRequest('web_fetch', {
      url: 'https://example.org/page',
    });
    expect(result.name).toBe('web_fetch');
    expect((result.args as { prompt: string }).prompt).toContain(
      'https://example.org/page',
    );
  });
});
