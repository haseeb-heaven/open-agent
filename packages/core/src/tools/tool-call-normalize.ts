/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Normalizes model tool calls before registry lookup / validation.
 *
 * Recovers common failures from weaker multi-provider models:
 * - display / class / placeholder names
 * - calling grep (SearchText) with file-glob args (FindFiles shape)
 * - using `*.*` / `**\/*.txt` as a regex content pattern
 * - parameter aliases (`path` vs `dir_path` / `file_path`, `cmd` vs `command`)
 */

import {
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  LS_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  READ_MANY_FILES_TOOL_NAME,
  SHELL_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  resolveCanonicalToolName,
  TOOL_LEGACY_ALIASES,
} from './tool-names.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isBooleanValue(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isNumberValue(value: unknown): value is number {
  return typeof value === 'number' && !Number.isNaN(value);
}

/**
 * True when `pattern` looks like a filename glob rather than a content regex.
 * Examples: `*.*`, `*.txt`, `**\/*.md`, `src/**\/*.ts`
 */
export function looksLikeFileGlobPattern(pattern: string): boolean {
  const p = pattern.trim();
  if (!p) return false;

  // Pure extension / multi-ext globs (invalid or nonsense as regex)
  if (/^\*\.[\w.*?{},-]+$/.test(p)) return true;
  if (/^\*\*\/.+/.test(p)) return true;
  if (/^[\w./-]*\*[\w.*?{},./-]*$/.test(p) && /[*?]/.test(p)) {
    // Path-ish globs with * or ?
    // Reject pure content regexes like `foo.*bar` without path separators / ext form
    if (
      p.includes('/') ||
      p.includes('\\') ||
      /^\*\./.test(p) ||
      p.endsWith('.*')
    ) {
      // `*.*` ends with .* — treat as glob when it also starts with *
      if (/^\*+\./.test(p) || p.includes('/') || p.includes('**')) {
        return true;
      }
    }
  }

  // If it is not a valid JS regex, and uses glob metacharacters, treat as glob.
  if (/[*?[{]/.test(p)) {
    try {
      new RegExp(p);
    } catch {
      return true;
    }
  }

  return false;
}

/**
 * Grep/SearchText was called with FindFiles/glob-shaped arguments.
 */
export function isGlobShapedSearchArgs(args: Record<string, unknown>): boolean {
  if (!isNonEmptyString(args['pattern'])) {
    return false;
  }

  const hasGlobOnlyFlags =
    isBooleanValue(args['case_sensitive']) ||
    isBooleanValue(args['respect_git_ignore']) ||
    isBooleanValue(args['respect_gemini_ignore']);

  const hasGrepOnlyFlags =
    isNonEmptyString(args['include_pattern']) ||
    isNonEmptyString(args['exclude_pattern']) ||
    isBooleanValue(args['names_only']) ||
    isBooleanValue(args['fixed_strings']) ||
    isNumberValue(args['max_matches_per_file']) ||
    isNumberValue(args['total_max_matches']) ||
    isNumberValue(args['context']) ||
    isNumberValue(args['after']) ||
    isNumberValue(args['before']);

  if (hasGlobOnlyFlags && !hasGrepOnlyFlags) {
    return true;
  }

  if (!hasGrepOnlyFlags && looksLikeFileGlobPattern(String(args['pattern']))) {
    return true;
  }

  return false;
}

function pickGlobArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    pattern: args['pattern'],
  };
  if (isNonEmptyString(args['dir_path'])) {
    out['dir_path'] = args['dir_path'];
  }
  if (isBooleanValue(args['case_sensitive'])) {
    out['case_sensitive'] = args['case_sensitive'];
  }
  if (isBooleanValue(args['respect_git_ignore'])) {
    out['respect_git_ignore'] = args['respect_git_ignore'];
  }
  if (isBooleanValue(args['respect_gemini_ignore'])) {
    out['respect_gemini_ignore'] = args['respect_gemini_ignore'];
  }
  return out;
}

function isGrepToolName(name: string): boolean {
  const canonical = TOOL_LEGACY_ALIASES[name] ?? name;
  return (
    canonical === GREP_TOOL_NAME ||
    name.toLowerCase() === GREP_TOOL_NAME ||
    name.toLowerCase() === 'searchtext' ||
    name.toLowerCase() === 'grep' ||
    name.toLowerCase() === 'greptool'
  );
}

export interface NormalizedToolCall {
  /** Canonical tool name after recovery. */
  name: string;
  /** Possibly rewritten args. */
  args: unknown;
  /** Present when the call was remapped from another tool. */
  remappedFrom?: string;
}

/**
 * First non-empty string among candidate keys on `args`.
 */
function firstString(
  args: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (isNonEmptyString(value)) {
      return value;
    }
  }
  return undefined;
}

const DOWNLOAD_DEST_KEYS = [
  'download_location',
  'save_path',
  'destination',
  'dest',
  'out_file',
  'output_path',
  'output',
  'target_path',
  'local_path',
] as const;

/**
 * Extract the first http(s) URL from free-form model args (url fields or text).
 */
export function extractHttpUrlFromArgs(
  args: Record<string, unknown>,
): string | undefined {
  const direct = firstString(args, [
    'url',
    'uri',
    'link',
    'href',
    'source_url',
    'download_url',
  ]);
  if (direct) {
    const cleaned = direct
      .replace(/^(web|url|link|fetch|download)\s*[:=]\s*/i, '')
      .trim();
    const m = cleaned.match(/https?:\/\/[^\s"'<>]+/i);
    if (m) return m[0].replace(/[),.;]+$/, '');
    if (/^https?:\/\//i.test(cleaned)) return cleaned;
  }

  for (const key of ['prompt', 'query', 'q', 'text', 'search']) {
    const text = args[key];
    if (!isNonEmptyString(text)) continue;
    const m = text.match(/https?:\/\/[^\s"'<>]+/i);
    if (m) return m[0].replace(/[),.;]+$/, '');
  }
  return undefined;
}

/**
 * True when the destination looks like a directory (not a concrete file path).
 */
export function looksLikeDirectoryPath(location: string): boolean {
  const t = location.trim();
  if (!t) return true;
  if (/[/\\]$/.test(t)) return true;
  // Bare folder names / paths without a file-ish final segment
  const base =
    t
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() ?? '';
  if (!base) return true;
  // Has an extension → treat as file; otherwise directory
  return !/\.[A-Za-z0-9]{1,8}$/.test(base);
}

/**
 * Resolve a final on-disk file path from a user/model save location + source URL.
 */
export function resolveDownloadDest(url: string, location: string): string {
  const loc = location.trim().replace(/^["']|["']$/g, '');
  if (!looksLikeDirectoryPath(loc)) {
    return loc;
  }
  let filename = 'download.bin';
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (last) {
      filename = decodeURIComponent(last.split('?')[0] || last);
    }
  } catch {
    // keep default
  }
  // Strip characters that break shell paths across platforms
  filename =
    filename
      .split('')
      .map((ch) => {
        const code = ch.charCodeAt(0);
        if (code < 32 || '<>:"|?*'.includes(ch)) return '_';
        return ch;
      })
      .join('')
      .trim() || 'download.bin';
  const sep = loc.includes('\\') && !loc.includes('/') ? '\\' : '/';
  const base = loc.replace(/[/\\]+$/, '');
  return `${base}${sep}${filename}`;
}

function shellSingleQuote(value: string): string {
  // POSIX single-quote escape: 'foo'bar' → 'foo'\''bar'
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function powershellSingleQuote(value: string): string {
  // PowerShell single-quoted string: double any '
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Build a platform-native shell command that downloads `url` to `destPath`.
 * Windows → PowerShell Invoke-WebRequest; otherwise curl.
 */
export function buildDownloadShellCommand(
  url: string,
  destPath: string,
): string {
  const isWin = process.platform === 'win32';
  if (isWin) {
    const u = powershellSingleQuote(url);
    const d = powershellSingleQuote(destPath);
    // Ensure parent directory exists, then download.
    return (
      `$dest = ${d}; $dir = Split-Path -Parent $dest; ` +
      `if ($dir -and -not (Test-Path -LiteralPath $dir)) { ` +
      `New-Item -ItemType Directory -Force -Path $dir | Out-Null }; ` +
      `Invoke-WebRequest -Uri ${u} -OutFile $dest -UseBasicParsing; ` +
      `Write-Output ('Downloaded to ' + $dest)`
    );
  }
  const u = shellSingleQuote(url);
  const d = shellSingleQuote(destPath);
  return (
    `mkdir -p "$(dirname ${d})" && curl -fsSL -L -o ${d} ${u} && ` +
    `echo "Downloaded to ${destPath.replace(/"/g, '')}"`
  );
}

/**
 * When the model tries to "download" via web_fetch (inventing download_location /
 * save_path), remap to run_shell_command so the file actually lands on disk.
 * web_fetch only reads/summarizes content — it never saves binaries.
 */
export function tryRemapWebFetchDownloadToShell(
  toolName: string,
  args: unknown,
): NormalizedToolCall | null {
  if (!isRecord(args)) return null;

  const canonical = TOOL_LEGACY_ALIASES[toolName] ?? toolName;
  const isWebFetch =
    canonical === WEB_FETCH_TOOL_NAME ||
    toolName === 'web_fetch' ||
    toolName === 'WebFetch' ||
    toolName.toLowerCase() === 'webfetch' ||
    toolName.toLowerCase() === 'download' ||
    toolName.toLowerCase() === 'download_file' ||
    toolName.toLowerCase() === 'downloadfile';

  if (!isWebFetch) return null;

  const dest = firstString(args, [...DOWNLOAD_DEST_KEYS]);
  if (!dest) return null;

  const url = extractHttpUrlFromArgs(args);
  if (!url) return null;

  const finalPath = resolveDownloadDest(url, dest);
  const command = buildDownloadShellCommand(url, finalPath);
  return {
    name: SHELL_TOOL_NAME,
    args: {
      command,
      description: `Download ${url} to ${finalPath}`,
    },
    remappedFrom: toolName,
  };
}

/**
 * Recover common parameter aliases weaker models emit
 * (e.g. `path` instead of `dir_path` / `file_path`).
 */
export function normalizeToolArgs(toolName: string, args: unknown): unknown {
  if (!isRecord(args)) {
    return args;
  }
  const out: Record<string, unknown> = { ...args };
  const canonical = TOOL_LEGACY_ALIASES[toolName] ?? toolName;

  if (canonical === LS_TOOL_NAME || toolName === 'list_directory') {
    if (!isNonEmptyString(out['dir_path'])) {
      const alt = firstString(out, [
        'path',
        'directory',
        'directory_path',
        'dir',
        'folder',
        'target_directory',
        'target_dir',
      ]);
      // Default to workspace root when the model omits the path entirely
      // (common on free/weak models that still intend "list here").
      out['dir_path'] = alt ?? '.';
    }
  }

  if (
    canonical === READ_FILE_TOOL_NAME ||
    canonical === WRITE_FILE_TOOL_NAME ||
    toolName === 'read_file' ||
    toolName === 'write_file'
  ) {
    if (!isNonEmptyString(out['file_path'])) {
      const alt = firstString(out, [
        'path',
        'file',
        'filename',
        'filepath',
        'target_file',
      ]);
      if (alt) out['file_path'] = alt;
    }
  }

  if (canonical === SHELL_TOOL_NAME || toolName === 'run_shell_command') {
    if (!isNonEmptyString(out['command'])) {
      const alt = firstString(out, ['cmd', 'shell', 'script', 'code']);
      if (alt) out['command'] = alt;
    }
  }

  if (canonical === GLOB_TOOL_NAME) {
    if (!isNonEmptyString(out['pattern'])) {
      const alt = firstString(out, ['glob', 'glob_pattern', 'file_pattern']);
      if (alt) out['pattern'] = alt;
    }
    // Glob's schema uses `path` (search root). Accept common aliases without
    // also forcing a duplicate when `dir_path` was only used for grep remap.
    if (!isNonEmptyString(out['path'])) {
      const alt = firstString(out, ['directory', 'cwd', 'root', 'dir']);
      if (alt) {
        out['path'] = alt;
      } else if (isNonEmptyString(out['dir_path'])) {
        out['path'] = out['dir_path'];
        delete out['dir_path'];
      }
    } else if ('dir_path' in out && out['dir_path'] === out['path']) {
      delete out['dir_path'];
    }
  }

  if (canonical === READ_MANY_FILES_TOOL_NAME) {
    if (!Array.isArray(out['include'])) {
      const single = firstString(out, [
        'path',
        'file_path',
        'file',
        'include_path',
      ]);
      if (single) out['include'] = [single];
    }
  }

  if (
    canonical === WEB_SEARCH_TOOL_NAME ||
    toolName === 'google_web_search' ||
    toolName === 'GoogleSearch' ||
    toolName === 'WebSearch'
  ) {
    if (!isNonEmptyString(out['query'])) {
      const alt = firstString(out, [
        'q',
        'search',
        'search_query',
        'text',
        'prompt',
        'question',
        'keywords',
      ]);
      if (alt) out['query'] = alt;
    }
  }

  if (
    canonical === WEB_FETCH_TOOL_NAME ||
    toolName === 'web_fetch' ||
    toolName === 'WebFetch'
  ) {
    // Models often invent alternate shapes: { query, url, download_location }
    // Schema only accepts `prompt` (URLs + instructions embedded in the string).
    if (!isNonEmptyString(out['prompt'])) {
      const candidates = [
        firstString(out, [
          'url',
          'uri',
          'link',
          'href',
          'query',
          'q',
          'search',
          'text',
          'prompt',
        ]),
      ].filter(
        (s): s is string => typeof s === 'string' && s.trim().length > 0,
      );

      let raw = candidates[0];
      if (raw) {
        // Strip common prefixes models invent: "web: https://...", "url=..."
        raw = raw.replace(/^(web|url|link|fetch)\s*[:=]\s*/i, '').trim();

        const urlMatch = raw.match(/https?:\/\/[^\s"'<>]+/i);
        const url = urlMatch ? urlMatch[0] : undefined;
        if (url) {
          const rest = raw.replace(url, '').trim();
          out['prompt'] = rest
            ? `${rest}\n\n${url}`
            : `Fetch and summarize: ${url}`;
        } else if (raw.startsWith('http')) {
          out['prompt'] = `Fetch and summarize: ${raw}`;
        } else {
          out['prompt'] = raw;
        }
      }
    }
    // Drop invented / non-schema fields so only `prompt` remains for validation.
    for (const drop of [
      'query',
      'q',
      'url',
      'uri',
      'link',
      'href',
      'download_location',
      'save_path',
      'path',
      'search',
      'text',
    ]) {
      if (drop in out && drop !== 'prompt') {
        delete out[drop];
      }
    }
  }

  // Write file: map body/text → content
  if (
    canonical === WRITE_FILE_TOOL_NAME ||
    toolName === 'write_file' ||
    toolName === 'WriteFile'
  ) {
    if (!isNonEmptyString(out['content'])) {
      const alt = firstString(out, ['body', 'text', 'data', 'file_content']);
      if (alt) out['content'] = alt;
    }
  }

  // Grep/glob: common alias `regex` / `glob_pattern` / `search`
  if (canonical === GREP_TOOL_NAME || canonical === GLOB_TOOL_NAME) {
    if (!isNonEmptyString(out['pattern'])) {
      const alt = firstString(out, [
        'regex',
        'query',
        'search',
        'glob_pattern',
        'file_pattern',
        'text',
      ]);
      if (alt) out['pattern'] = alt;
    }
  }

  return out;
}

/**
 * When the model emits `google_web_search` with empty args, use the last user
 * utterance as the query. No domain-specific parsing — search backends accept
 * natural language, so the raw user text is the safest generic fallback.
 */
export function extractSearchQueryFromUserText(
  userText: string | undefined,
): string | undefined {
  if (!userText) return undefined;
  const q = userText.trim();
  if (!q) return undefined;
  // Soft cap only — avoid unbounded tool args; not topic-specific.
  return q.length > 500 ? q.slice(0, 500) : q;
}

export function normalizeToolCallRequest(
  name: string,
  args: unknown,
  options: {
    knownNames?: readonly string[];
    /** Last user utterance — used to fill empty web_search query */
    lastUserText?: string;
  } = {},
): NormalizedToolCall {
  const resolvedName = resolveCanonicalToolName(name, {
    knownNames: options.knownNames,
    args,
  });

  // Empty placeholder tool names cannot be recovered — leave as-is so the
  // scheduler returns a clear "not found" + available tools list.
  if (
    (resolvedName === 'generic_tool' || name === 'generic_tool') &&
    (!isRecord(args) || Object.keys(args).length === 0)
  ) {
    return { name: 'generic_tool', args: args ?? {} };
  }

  if (
    isRecord(args) &&
    isGrepToolName(resolvedName) &&
    isGlobShapedSearchArgs(args)
  ) {
    return {
      name: GLOB_TOOL_NAME,
      args: normalizeToolArgs(GLOB_TOOL_NAME, pickGlobArgs(args)),
      remappedFrom: resolvedName,
    };
  }

  // Also when the model used the display name SearchText but args are glob-shaped
  // before alias resolution (already handled by isGrepToolName on original).
  if (
    isRecord(args) &&
    isGrepToolName(name) &&
    resolvedName !== GLOB_TOOL_NAME &&
    isGlobShapedSearchArgs(args)
  ) {
    return {
      name: GLOB_TOOL_NAME,
      args: normalizeToolArgs(GLOB_TOOL_NAME, pickGlobArgs(args)),
      remappedFrom: name,
    };
  }

  // web_fetch + download_location/save_path + URL → shell download (real file).
  // Check original args before normalizeToolArgs strips non-schema fields.
  const downloadRemap = tryRemapWebFetchDownloadToShell(resolvedName, args);
  if (downloadRemap) {
    return downloadRemap;
  }
  // Also when the model used display/unknown name "download" that did not resolve
  if (resolvedName !== name) {
    const downloadRemapOrig = tryRemapWebFetchDownloadToShell(name, args);
    if (downloadRemapOrig) {
      return downloadRemapOrig;
    }
  }

  let nextArgs = normalizeToolArgs(resolvedName, args);

  // Recover empty google_web_search query from the latest user message
  if (
    (resolvedName === WEB_SEARCH_TOOL_NAME ||
      name === 'google_web_search' ||
      name === 'GoogleSearch' ||
      name === 'WebSearch') &&
    isRecord(nextArgs) &&
    !isNonEmptyString(nextArgs['query'])
  ) {
    const recovered = extractSearchQueryFromUserText(options.lastUserText);
    if (recovered) {
      nextArgs = { ...nextArgs, query: recovered };
    }
  }

  return {
    name: resolvedName,
    args: nextArgs,
  };
}
