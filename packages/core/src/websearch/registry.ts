/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { braveBackend } from './backends/brave.js';
import { duckduckgoBackend } from './backends/duckduckgo.js';
import { exaBackend } from './backends/exa.js';
import { geminiBackend } from './backends/gemini.js';
import { serperBackend } from './backends/serper.js';
import { tavilyBackend } from './backends/tavily.js';
import { webzBackend } from './backends/webz.js';
import type { WebSearchBackend } from './types.js';

/** All built-in web search backends (wizard + router). */
export const WEB_SEARCH_BACKENDS: readonly WebSearchBackend[] = [
  braveBackend,
  tavilyBackend,
  webzBackend,
  serperBackend,
  exaBackend,
  geminiBackend,
  duckduckgoBackend,
] as const;

export function getWebSearchBackend(id: string): WebSearchBackend | undefined {
  const needle = id.trim().toLowerCase();
  return WEB_SEARCH_BACKENDS.find((b) => b.meta.id === needle);
}

export function listWebSearchProviders(): WebSearchBackend[] {
  return [...WEB_SEARCH_BACKENDS];
}
