/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  LS_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  SHELL_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  EDIT_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WRITE_TODOS_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  READ_MANY_FILES_TOOL_NAME,
  GET_INTERNAL_DOCS_TOOL_NAME,
  ACTIVATE_SKILL_TOOL_NAME,
  ASK_USER_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  // Shared parameter names
  PARAM_FILE_PATH,
  PARAM_DIR_PATH,
  PARAM_PATTERN,
  PARAM_CASE_SENSITIVE,
  PARAM_RESPECT_GIT_IGNORE,
  PARAM_RESPECT_GEMINI_IGNORE,
  PARAM_FILE_FILTERING_OPTIONS,
  PARAM_DESCRIPTION,
  // Tool-specific parameter names
  READ_FILE_PARAM_START_LINE,
  READ_FILE_PARAM_END_LINE,
  WRITE_FILE_PARAM_CONTENT,
  GREP_PARAM_INCLUDE_PATTERN,
  GREP_PARAM_EXCLUDE_PATTERN,
  GREP_PARAM_NAMES_ONLY,
  GREP_PARAM_MAX_MATCHES_PER_FILE,
  GREP_PARAM_TOTAL_MAX_MATCHES,
  GREP_PARAM_FIXED_STRINGS,
  GREP_PARAM_CONTEXT,
  GREP_PARAM_AFTER,
  GREP_PARAM_BEFORE,
  GREP_PARAM_NO_IGNORE,
  EDIT_PARAM_INSTRUCTION,
  EDIT_PARAM_OLD_STRING,
  EDIT_PARAM_NEW_STRING,
  EDIT_PARAM_ALLOW_MULTIPLE,
  LS_PARAM_IGNORE,
  SHELL_PARAM_COMMAND,
  SHELL_PARAM_IS_BACKGROUND,
  WEB_SEARCH_PARAM_QUERY,
  WEB_FETCH_PARAM_PROMPT,
  READ_MANY_PARAM_INCLUDE,
  READ_MANY_PARAM_EXCLUDE,
  READ_MANY_PARAM_RECURSIVE,
  READ_MANY_PARAM_USE_DEFAULT_EXCLUDES,
  TODOS_PARAM_TODOS,
  TODOS_ITEM_PARAM_DESCRIPTION,
  TODOS_ITEM_PARAM_STATUS,
  DOCS_PARAM_PATH,
  ASK_USER_PARAM_QUESTIONS,
  ASK_USER_QUESTION_PARAM_QUESTION,
  ASK_USER_QUESTION_PARAM_HEADER,
  ASK_USER_QUESTION_PARAM_TYPE,
  ASK_USER_QUESTION_PARAM_OPTIONS,
  ASK_USER_QUESTION_PARAM_MULTI_SELECT,
  ASK_USER_QUESTION_PARAM_PLACEHOLDER,
  ASK_USER_OPTION_PARAM_LABEL,
  ASK_USER_OPTION_PARAM_DESCRIPTION,
  PLAN_MODE_PARAM_REASON,
  EXIT_PLAN_PARAM_PLAN_FILENAME,
  SKILL_PARAM_NAME,
  UPDATE_TOPIC_TOOL_NAME,
  UPDATE_TOPIC_DISPLAY_NAME,
  COMPLETE_TASK_TOOL_NAME,
  COMPLETE_TASK_DISPLAY_NAME,
  READ_MCP_RESOURCE_TOOL_NAME,
  LIST_MCP_RESOURCES_TOOL_NAME,
  TOPIC_PARAM_TITLE,
  TOPIC_PARAM_SUMMARY,
  TOPIC_PARAM_STRATEGIC_INTENT,
} from './definitions/coreTools.js';

export {
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  LS_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  SHELL_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  EDIT_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WRITE_TODOS_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  READ_MANY_FILES_TOOL_NAME,
  GET_INTERNAL_DOCS_TOOL_NAME,
  ACTIVATE_SKILL_TOOL_NAME,
  ASK_USER_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  UPDATE_TOPIC_TOOL_NAME,
  UPDATE_TOPIC_DISPLAY_NAME,
  COMPLETE_TASK_TOOL_NAME,
  COMPLETE_TASK_DISPLAY_NAME,
  READ_MCP_RESOURCE_TOOL_NAME,
  LIST_MCP_RESOURCES_TOOL_NAME,
  // Shared parameter names
  PARAM_FILE_PATH,
  PARAM_DIR_PATH,
  PARAM_PATTERN,
  PARAM_CASE_SENSITIVE,
  PARAM_RESPECT_GIT_IGNORE,
  PARAM_RESPECT_GEMINI_IGNORE,
  PARAM_FILE_FILTERING_OPTIONS,
  PARAM_DESCRIPTION,
  // Tool-specific parameter names
  READ_FILE_PARAM_START_LINE,
  READ_FILE_PARAM_END_LINE,
  WRITE_FILE_PARAM_CONTENT,
  GREP_PARAM_INCLUDE_PATTERN,
  GREP_PARAM_EXCLUDE_PATTERN,
  GREP_PARAM_NAMES_ONLY,
  GREP_PARAM_MAX_MATCHES_PER_FILE,
  GREP_PARAM_TOTAL_MAX_MATCHES,
  GREP_PARAM_FIXED_STRINGS,
  GREP_PARAM_CONTEXT,
  GREP_PARAM_AFTER,
  GREP_PARAM_BEFORE,
  GREP_PARAM_NO_IGNORE,
  EDIT_PARAM_INSTRUCTION,
  EDIT_PARAM_OLD_STRING,
  EDIT_PARAM_NEW_STRING,
  EDIT_PARAM_ALLOW_MULTIPLE,
  LS_PARAM_IGNORE,
  SHELL_PARAM_COMMAND,
  SHELL_PARAM_IS_BACKGROUND,
  WEB_SEARCH_PARAM_QUERY,
  WEB_FETCH_PARAM_PROMPT,
  READ_MANY_PARAM_INCLUDE,
  READ_MANY_PARAM_EXCLUDE,
  READ_MANY_PARAM_RECURSIVE,
  READ_MANY_PARAM_USE_DEFAULT_EXCLUDES,
  TODOS_PARAM_TODOS,
  TODOS_ITEM_PARAM_DESCRIPTION,
  TODOS_ITEM_PARAM_STATUS,
  DOCS_PARAM_PATH,
  ASK_USER_PARAM_QUESTIONS,
  ASK_USER_QUESTION_PARAM_QUESTION,
  ASK_USER_QUESTION_PARAM_HEADER,
  ASK_USER_QUESTION_PARAM_TYPE,
  ASK_USER_QUESTION_PARAM_OPTIONS,
  ASK_USER_QUESTION_PARAM_MULTI_SELECT,
  ASK_USER_QUESTION_PARAM_PLACEHOLDER,
  ASK_USER_OPTION_PARAM_LABEL,
  ASK_USER_OPTION_PARAM_DESCRIPTION,
  PLAN_MODE_PARAM_REASON,
  EXIT_PLAN_PARAM_PLAN_FILENAME,
  SKILL_PARAM_NAME,
  TOPIC_PARAM_TITLE,
  TOPIC_PARAM_SUMMARY,
  TOPIC_PARAM_STRATEGIC_INTENT,
};

export const EDIT_TOOL_NAMES = new Set([EDIT_TOOL_NAME, WRITE_FILE_TOOL_NAME]);

/**
 * Tools that require mandatory argument narrowing (e.g., file paths, command prefixes)
 * when granting persistent or session-wide approval.
 */
export const TOOLS_REQUIRING_NARROWING = new Set([
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_MANY_FILES_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  LS_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  EDIT_TOOL_NAME,
  SHELL_TOOL_NAME,
]);

export const TRACKER_CREATE_TASK_TOOL_NAME = 'tracker_create_task';
export const TRACKER_UPDATE_TASK_TOOL_NAME = 'tracker_update_task';
export const TRACKER_GET_TASK_TOOL_NAME = 'tracker_get_task';
export const TRACKER_LIST_TASKS_TOOL_NAME = 'tracker_list_tasks';
export const TRACKER_ADD_DEPENDENCY_TOOL_NAME = 'tracker_add_dependency';
export const TRACKER_VISUALIZE_TOOL_NAME = 'tracker_visualize';

export const AGENT_TOOL_NAME = 'invoke_agent';

// Tool Display Names
export const WRITE_FILE_DISPLAY_NAME = 'WriteFile';
export const EDIT_DISPLAY_NAME = 'Edit';
export const ASK_USER_DISPLAY_NAME = 'Ask User';
export const READ_FILE_DISPLAY_NAME = 'ReadFile';
export const GLOB_DISPLAY_NAME = 'FindFiles';
export const LS_DISPLAY_NAME = 'ReadFolder';
export const GREP_DISPLAY_NAME = 'SearchText';
export const WEB_SEARCH_DISPLAY_NAME = 'GoogleSearch';
export const WEB_FETCH_DISPLAY_NAME = 'WebFetch';
export const READ_MANY_FILES_DISPLAY_NAME = 'ReadManyFiles';

/**
 * Mapping of legacy / alternate tool names to their current names.
 * This ensures backward compatibility for user-defined policies, skills, and hooks,
 * and recovers common model hallucinations (display names, class names, etc.).
 */
export const TOOL_LEGACY_ALIASES: Record<string, string> = {
  // Add future renames here, e.g.:
  search_file_content: GREP_TOOL_NAME,

  // Display / class names models often emit instead of the schema name
  Shell: SHELL_TOOL_NAME,
  ShellTool: SHELL_TOOL_NAME,
  shell: SHELL_TOOL_NAME,
  bash: SHELL_TOOL_NAME,
  terminal: SHELL_TOOL_NAME,
  run_command: SHELL_TOOL_NAME,
  execute: SHELL_TOOL_NAME,
  execute_command: SHELL_TOOL_NAME,
  execute_shell: SHELL_TOOL_NAME,
  powershell: SHELL_TOOL_NAME,
  cmd: SHELL_TOOL_NAME,

  ReadFile: READ_FILE_TOOL_NAME,
  ReadFileTool: READ_FILE_TOOL_NAME,
  WriteFile: WRITE_FILE_TOOL_NAME,
  WriteFileTool: WRITE_FILE_TOOL_NAME,
  Edit: EDIT_TOOL_NAME,
  EditTool: EDIT_TOOL_NAME,
  Grep: GREP_TOOL_NAME,
  GrepTool: GREP_TOOL_NAME,
  SearchText: GREP_TOOL_NAME,
  FindFiles: GLOB_TOOL_NAME,
  Glob: GLOB_TOOL_NAME,
  ReadFolder: LS_TOOL_NAME,
  ListDirectory: LS_TOOL_NAME,
  GoogleSearch: WEB_SEARCH_TOOL_NAME,
  WebSearch: WEB_SEARCH_TOOL_NAME,
  WebFetch: WEB_FETCH_TOOL_NAME,
  // Models invent a "download" tool for save-to-disk; route via web_fetch
  // normalize which remaps to shell when a destination path is present.
  download: WEB_FETCH_TOOL_NAME,
  download_file: WEB_FETCH_TOOL_NAME,
  DownloadFile: WEB_FETCH_TOOL_NAME,
  Download: WEB_FETCH_TOOL_NAME,
};

/**
 * Infer the intended built-in tool from call arguments when the model used an
 * unknown or placeholder tool name (e.g. `generic_tool`).
 *
 * Returns a built-in tool name only when the arg shape is unambiguous.
 */
function isPlainArgs(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasStringField(args: Record<string, unknown>, key: string): boolean {
  const value = args[key];
  return typeof value === 'string';
}

export function inferToolNameFromArgs(args: unknown): string | undefined {
  if (!isPlainArgs(args)) {
    return undefined;
  }
  const a = args;

  // Shell: primary recovery path for hallucinated tools like generic_tool
  if (hasStringField(a, SHELL_PARAM_COMMAND)) {
    return SHELL_TOOL_NAME;
  }

  // File writes / edits before plain reads (more specific first)
  if (
    hasStringField(a, PARAM_FILE_PATH) &&
    hasStringField(a, WRITE_FILE_PARAM_CONTENT)
  ) {
    return WRITE_FILE_TOOL_NAME;
  }
  if (
    hasStringField(a, PARAM_FILE_PATH) &&
    (hasStringField(a, EDIT_PARAM_OLD_STRING) ||
      hasStringField(a, EDIT_PARAM_NEW_STRING))
  ) {
    return EDIT_TOOL_NAME;
  }
  if (hasStringField(a, PARAM_FILE_PATH)) {
    return READ_FILE_TOOL_NAME;
  }

  if (hasStringField(a, WEB_SEARCH_PARAM_QUERY)) {
    return WEB_SEARCH_TOOL_NAME;
  }
  // URL + save path → download intent (handled by web_fetch→shell remap)
  if (
    (hasStringField(a, 'url') ||
      hasStringField(a, 'uri') ||
      hasStringField(a, 'link')) &&
    (hasStringField(a, 'download_location') ||
      hasStringField(a, 'save_path') ||
      hasStringField(a, 'destination') ||
      hasStringField(a, 'out_file') ||
      hasStringField(a, 'output_path'))
  ) {
    return WEB_FETCH_TOOL_NAME;
  }
  if (hasStringField(a, WEB_FETCH_PARAM_PROMPT)) {
    return WEB_FETCH_TOOL_NAME;
  }

  // Grep vs glob: prefer glob when args look like file-name search
  // (extension globs, gitignore flags, case_sensitive without grep fields).
  if (hasStringField(a, PARAM_PATTERN)) {
    const pattern = String(a[PARAM_PATTERN]);
    const hasGrepFields =
      typeof a[GREP_PARAM_INCLUDE_PATTERN] === 'string' ||
      typeof a[GREP_PARAM_EXCLUDE_PATTERN] === 'string' ||
      a[GREP_PARAM_NAMES_ONLY] !== undefined ||
      a[GREP_PARAM_CONTEXT] !== undefined ||
      a[GREP_PARAM_AFTER] !== undefined ||
      a[GREP_PARAM_BEFORE] !== undefined;
    const hasGlobFlags =
      typeof a[PARAM_CASE_SENSITIVE] === 'boolean' ||
      typeof a[PARAM_RESPECT_GIT_IGNORE] === 'boolean' ||
      typeof a[PARAM_RESPECT_GEMINI_IGNORE] === 'boolean';
    const looksLikeGlob =
      /^\*\.[\w.*?{},-]+$/.test(pattern.trim()) ||
      /^\*\*\//.test(pattern.trim()) ||
      (hasGlobFlags && !hasGrepFields);

    if (looksLikeGlob && !hasGrepFields) {
      return GLOB_TOOL_NAME;
    }
    if (hasGrepFields) {
      return GREP_TOOL_NAME;
    }
    // Bare content-ish pattern → grep is the more common intent.
    return GREP_TOOL_NAME;
  }

  if (typeof a[PARAM_DIR_PATH] === 'string' && Object.keys(a).length <= 3) {
    return LS_TOOL_NAME;
  }

  return undefined;
}

/**
 * Resolve a model-emitted tool name to a canonical registered name.
 * Order: exact alias map → case-insensitive alias → case-insensitive match
 * against known names → arg-shape inference.
 */
export function resolveCanonicalToolName(
  name: string,
  options: {
    knownNames?: readonly string[];
    args?: unknown;
  } = {},
): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) {
    return name;
  }

  // Exact legacy / display alias
  if (TOOL_LEGACY_ALIASES[trimmed]) {
    return TOOL_LEGACY_ALIASES[trimmed];
  }

  // Case-insensitive alias
  const lower = trimmed.toLowerCase();
  for (const [alias, canonical] of Object.entries(TOOL_LEGACY_ALIASES)) {
    if (alias.toLowerCase() === lower) {
      return canonical;
    }
  }

  // Case-insensitive match against known registered tool names
  const known = options.knownNames ?? ALL_BUILTIN_TOOL_NAMES;
  for (const knownName of known) {
    if (knownName.toLowerCase() === lower) {
      return knownName;
    }
  }

  // Arg-shape recovery for completely unknown names (generic_tool, etc.)
  const inferred = inferToolNameFromArgs(options.args);
  if (inferred && known.includes(inferred)) {
    return inferred;
  }

  return trimmed;
}

/**
 * Returns all associated names for a tool (including legacy aliases and current name).
 * This ensures that if multiple legacy names point to the same tool, we consider all of them
 * for policy application.
 */
export function getToolAliases(name: string): string[] {
  const aliases = new Set<string>([name]);

  // Determine the canonical (current) name
  const canonicalName = TOOL_LEGACY_ALIASES[name] ?? name;
  aliases.add(canonicalName);

  // Find all other legacy aliases that point to the same canonical name
  for (const [legacyName, currentName] of Object.entries(TOOL_LEGACY_ALIASES)) {
    if (currentName === canonicalName) {
      aliases.add(legacyName);
    }
  }

  return Array.from(aliases);
}

/** Prefix used for tools discovered via the tool DiscoveryCommand. */
export const DISCOVERED_TOOL_PREFIX = 'discovered_tool_';

/**
 * List of all built-in tool names.
 */
import {
  isMcpToolName,
  parseMcpToolName,
  MCP_TOOL_PREFIX,
} from './mcp-tool.js';

export const ALL_BUILTIN_TOOL_NAMES = [
  GLOB_TOOL_NAME,
  WRITE_TODOS_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  EDIT_TOOL_NAME,
  SHELL_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_MANY_FILES_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  LS_TOOL_NAME,
  ACTIVATE_SKILL_TOOL_NAME,
  ASK_USER_TOOL_NAME,
  TRACKER_CREATE_TASK_TOOL_NAME,
  TRACKER_UPDATE_TASK_TOOL_NAME,
  TRACKER_GET_TASK_TOOL_NAME,
  TRACKER_LIST_TASKS_TOOL_NAME,
  TRACKER_ADD_DEPENDENCY_TOOL_NAME,
  TRACKER_VISUALIZE_TOOL_NAME,
  GET_INTERNAL_DOCS_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  UPDATE_TOPIC_TOOL_NAME,
  COMPLETE_TASK_TOOL_NAME,
  AGENT_TOOL_NAME,
  READ_MCP_RESOURCE_TOOL_NAME,
  LIST_MCP_RESOURCES_TOOL_NAME,
] as const;

/**
 * Read-only tools available in Plan Mode.
 * This list is used to dynamically generate the Plan Mode prompt,
 * filtered by what tools are actually enabled in the current configuration.
 */
export const PLAN_MODE_TOOLS = [
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  LS_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  ASK_USER_TOOL_NAME,
  ACTIVATE_SKILL_TOOL_NAME,
  GET_INTERNAL_DOCS_TOOL_NAME,
  UPDATE_TOPIC_TOOL_NAME,
  'codebase_investigator',
  'cli_help',
  READ_MCP_RESOURCE_TOOL_NAME,
  LIST_MCP_RESOURCES_TOOL_NAME,
] as const;

/**
 * Validates if a tool name is syntactically valid.
 * Checks against built-in tools, discovered tools, and MCP naming conventions.
 */
export function isValidToolName(
  name: string,
  options: { allowWildcards?: boolean } = {},
): boolean {
  // Built-in tools
  if ((ALL_BUILTIN_TOOL_NAMES as readonly string[]).includes(name)) {
    return true;
  }

  // Legacy aliases
  if (TOOL_LEGACY_ALIASES[name]) {
    return true;
  }

  // Discovered tools
  if (name.startsWith(DISCOVERED_TOOL_PREFIX)) {
    return true;
  }

  // Policy wildcards
  if (options.allowWildcards && name === '*') {
    return true;
  }

  // Handle standard MCP FQNs (mcp_server_tool or wildcards mcp_*, mcp_server_*)
  if (isMcpToolName(name)) {
    // Global wildcard: mcp_*
    if (name === `${MCP_TOOL_PREFIX}*` && options.allowWildcards) {
      return true;
    }

    // Explicitly reject names with empty server component (e.g. mcp__tool)
    if (name.startsWith(`${MCP_TOOL_PREFIX}_`)) {
      return false;
    }

    const parsed = parseMcpToolName(name);
    // Ensure that both components are populated. parseMcpToolName splits at the second _,
    // so `mcp__tool` has serverName="", toolName="tool"
    if (parsed.serverName && parsed.toolName) {
      // Basic slug validation for server and tool names.
      // We allow dots (.) and colons (:) as they are valid in function names and
      // used for truncation markers.
      const slugRegex = /^[a-z0-9_.:-]+$/i;

      if (!slugRegex.test(parsed.serverName)) {
        return false;
      }

      if (parsed.toolName === '*') {
        return options.allowWildcards === true;
      }

      // A tool name consisting only of underscores is invalid.
      if (/^_*$/.test(parsed.toolName)) {
        return false;
      }

      return slugRegex.test(parsed.toolName);
    }

    return false;
  }

  return false;
}
