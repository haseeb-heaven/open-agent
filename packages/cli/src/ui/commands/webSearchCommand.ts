/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  listWebSearchProviders,
  planWebSearchRoute,
  webSearchProviderHelpTable,
  writeEnvKey,
  getDefaultEnvFilePath,
  openBrowserSecurely,
  getWebSearchBackend,
  recommendedWebSearchProviderId,
  inferModelFamily,
  keyStatusLabel,
} from '@open-agent/core';
import {
  type CommandContext,
  CommandKind,
  type SlashCommand,
  type SlashCommandActionReturn,
} from './types.js';
import { MessageType } from '../types.js';

function activeModelId(context: CommandContext): string | undefined {
  try {
    const model: unknown = context.services.agentContext?.config?.getModel?.();
    return typeof model === 'string' && model.trim() ? model : undefined;
  } catch {
    return undefined;
  }
}

export const webSearchCommand: SlashCommand = {
  name: 'websearch',
  altNames: ['web-search', 'search-keys'],
  description:
    'Web search providers: list, save keys, open signup pages. /websearch open <id> when key is empty.',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<SlashCommandActionReturn | void> => {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const modelId = activeModelId(context);
    const family = inferModelFamily(modelId);
    const recommended = recommendedWebSearchProviderId(family);

    if (parts.length === 0) {
      // Interactive settings wizard (recommended badges + key paste / open signup)
      return {
        type: 'dialog',
        dialog: 'websearch',
      };
    }

    if (parts[0]?.toLowerCase() === 'list') {
      const plan = planWebSearchRoute({ modelId });
      const header = [
        `Active model: ${modelId ?? '(unknown)'}  ·  family: ${family}`,
        `Recommended web search: ${recommended} — ${plan.reason}`,
        '',
        webSearchProviderHelpTable(process.env, modelId),
      ].join('\n');
      context.ui.addItem({ type: MessageType.INFO, text: header }, Date.now());
      return;
    }

    // /websearch open <id>
    if (parts[0]?.toLowerCase() === 'open') {
      const id = parts[1]?.toLowerCase();
      if (!id) {
        context.ui.addItem(
          {
            type: MessageType.ERROR,
            text: 'Usage: /websearch open <provider-id>  (e.g. /websearch open brave)',
          },
          Date.now(),
        );
        return;
      }
      const backend = getWebSearchBackend(id);
      if (!backend) {
        const known = listWebSearchProviders()
          .map((b) => b.meta.id)
          .join(', ');
        context.ui.addItem(
          {
            type: MessageType.ERROR,
            text: `Unknown web search provider "${id}". Known: ${known}`,
          },
          Date.now(),
        );
        return;
      }
      if (!backend.meta.signupUrl) {
        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: `${backend.meta.displayName} needs no API key (or has no signup URL).`,
          },
          Date.now(),
        );
        return;
      }
      try {
        await openBrowserSecurely(backend.meta.signupUrl);
        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: `Opened ${backend.meta.signupUrl}\nCreate a key, then: /websearch ${backend.meta.id} <your-key>`,
          },
          Date.now(),
        );
      } catch (error) {
        context.ui.addItem(
          {
            type: MessageType.ERROR,
            text: `Could not open browser: ${error instanceof Error ? error.message : String(error)}\nOpen manually: ${backend.meta.signupUrl}`,
          },
          Date.now(),
        );
      }
      return;
    }

    const id = parts[0]?.toLowerCase();
    const backend = id ? getWebSearchBackend(id) : undefined;
    if (!backend) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: `Unknown provider "${parts[0]}". Run /websearch for the list.`,
        },
        Date.now(),
      );
      return;
    }

    // /websearch <id>  → details
    if (parts.length === 1) {
      const keyName = backend.meta.envKey;
      const hasKey = keyName ? Boolean(process.env[keyName]?.trim()) : true;
      const rec =
        backend.meta.id === recommended
          ? ' (★ recommended for this model)'
          : '';
      const lines = [
        `${backend.meta.displayName}${rec}`,
        `  id:     ${backend.meta.id}`,
        `  env:    ${keyName ?? '(none)'}`,
        `  status: ${keyStatusLabel(backend.meta)}`,
        `  notes:  ${backend.meta.notes}`,
      ];
      if (backend.meta.signupUrl) {
        lines.push(`  signup: ${backend.meta.signupUrl}`);
        if (!hasKey && !backend.meta.freeNoKey && !backend.meta.keyOptional) {
          lines.push(
            '',
            'No key set. Press:  /websearch open ' +
              backend.meta.id +
              '  to open the signup page,',
            'then:  /websearch ' + backend.meta.id + ' <api-key>',
          );
        }
      }
      context.ui.addItem(
        { type: MessageType.INFO, text: lines.join('\n') },
        Date.now(),
      );
      return;
    }

    // /websearch <id> <key>
    const apiKey = parts.slice(1).join(' ').trim();
    if (!backend.meta.envKey) {
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: `${backend.meta.displayName} does not use an API key.`,
        },
        Date.now(),
      );
      return;
    }
    if (!apiKey) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: `Usage: /websearch ${backend.meta.id} <api-key>\nOr open signup: /websearch open ${backend.meta.id}`,
        },
        Date.now(),
      );
      return;
    }

    try {
      const envPath = getDefaultEnvFilePath();
      writeEnvKey(envPath, backend.meta.envKey, apiKey);
      process.env[backend.meta.envKey] = apiKey;
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: `Saved ${backend.meta.envKey} to ${envPath}.\nWeb search via ${backend.meta.displayName} is ready.\nForce with WEB_SEARCH_PROVIDER=${backend.meta.id} if desired.`,
        },
        Date.now(),
      );
    } catch (error) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: error instanceof Error ? error.message : String(error),
        },
        Date.now(),
      );
    }
  },
};
