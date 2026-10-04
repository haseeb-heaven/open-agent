/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * /model dialog for the multi-provider fork: lists every model from
 * configs/models.toml grouped by provider (plus detected Ollama /
 * LM Studio models), and lets the user switch to any of them. Selecting
 * a cloud model always surfaces an API-key step: if a key is already in
 * .env / process.env it is shown masked in the text box; otherwise the
 * user is asked to paste one. Free OpenRouter/etc. models still need keys.
 */

import type React from 'react';
import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import {
  ModelSlashCommandEvent,
  isLMStudioRunning,
  isOllamaRunning,
  listLMStudioModels,
  listOllamaModels,
  logModelSlashCommand,
  writeEnvKey,
  getDefaultEnvFilePath,
  getModelRegistry,
  groupModelsByProvider,
  providerApiKey,
  resolveActiveProvider,
  type PickerGroup,
  type PickerModel,
  type ProviderDefinition,
} from '@open-agent/core';
import { useKeypress } from '../hooks/useKeypress.js';
import { theme } from '../semantic-colors.js';
import { DescriptiveRadioButtonSelect } from './shared/DescriptiveRadioButtonSelect.js';
import { TextInput } from './shared/TextInput.js';
import { useTextBuffer } from './shared/text-buffer.js';
import { ConfigContext } from '../contexts/ConfigContext.js';

interface ProviderModelDialogProps {
  onClose: () => void;
}

interface DialogEntry {
  model: PickerModel;
  provider: ProviderDefinition;
}

function tierLabel(model: PickerModel): string {
  switch (model.tier) {
    case 'free':
      return 'free';
    case 'free_tier':
      return 'free tier';
    case 'local':
      return 'local';
    default:
      return 'paid';
  }
}

function maskKey(key: string): string {
  const t = key.trim();
  if (t.length <= 8) return '••••••••';
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

export function ProviderModelDialog({
  onClose,
}: ProviderModelDialogProps): React.JSX.Element {
  const config = useContext(ConfigContext);
  // Registry models render immediately; detected local models are added
  // asynchronously when an Ollama / LM Studio server responds.
  const [groups, setGroups] = useState<PickerGroup[]>(() =>
    groupModelsByProvider({ registry: getModelRegistry() }),
  );
  const [pendingKeyEntry, setPendingKeyEntry] = useState<DialogEntry | null>(
    null,
  );
  const [existingKey, setExistingKey] = useState<string | undefined>();
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const detected: Partial<Record<'ollama' | 'lmstudio', string[]>> = {};
      const [ollamaUp, lmStudioUp] = await Promise.all([
        isOllamaRunning(),
        isLMStudioRunning(),
      ]);
      if (!ollamaUp && !lmStudioUp) return;
      if (ollamaUp) detected.ollama = await listOllamaModels();
      if (lmStudioUp) detected.lmstudio = await listLMStudioModels();
      if (cancelled) return;
      setGroups(
        groupModelsByProvider({
          registry: getModelRegistry(),
          detectedLocalModels: detected,
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const entries = useMemo(() => {
    const map = new Map<string, DialogEntry>();
    for (const group of groups) {
      for (const model of group.models) {
        map.set(model.key, { model, provider: group.provider });
      }
    }
    return map;
  }, [groups]);

  const items = useMemo(
    () =>
      [...entries.values()].map(({ model, provider }) => ({
        value: model.key,
        key: model.key,
        title: `${model.available ? '✓' : '✗'} ${model.key}`,
        description: `${provider.displayName} · ${tierLabel(model)}${
          model.notes ? ` · ${model.notes}` : ''
        }${
          !model.available && provider.envKey
            ? ` · needs ${String(provider.envKey)}`
            : model.available && provider.envKey
              ? ` · ${String(provider.envKey)} set`
              : ''
        }`,
      })),
    [entries],
  );

  const initialIndex = useMemo(() => {
    const current = config?.getModel();
    if (!current) return 0;
    const idx = items.findIndex((item) => item.value === current);
    return idx === -1 ? 0 : idx;
  }, [config, items]);

  const applyModel = useCallback(
    (entry: DialogEntry) => {
      if (config) {
        // Persist selection so restarts keep the provider/model.
        // Registry keys are unique (LiteLLM ids can be shared by aliases).
        config.setModel(entry.model.key, false);
        logModelSlashCommand(
          config,
          new ModelSlashCommandEvent(entry.model.key),
        );
      }
      onClose();
    },
    [config, onClose],
  );

  const promptForKey = useCallback((entry: DialogEntry) => {
    const key = entry.provider.envKey
      ? providerApiKey(entry.provider, process.env)
      : undefined;
    setExistingKey(key);
    setNotice('');
    setPendingKeyEntry(entry);
  }, []);

  const handleSelect = useCallback(
    (key: string) => {
      const entry = entries.get(key);
      if (!entry) return;

      // Local providers never need an API key — only a running server.
      if (entry.provider.local) {
        if (entry.model.available) {
          applyModel(entry);
          return;
        }
        setNotice(
          `${entry.provider.displayName} is a local provider — start its server ` +
            '(Ollama: localhost:11434, LM Studio: localhost:1234) and reopen /model.',
        );
        return;
      }

      // Cloud providers (including free-tier OpenRouter/Groq/etc.) always
      // need an API key. If one is already in .env, show it masked so the
      // user can confirm or replace it; otherwise ask for a new key.
      if (entry.provider.envKey) {
        promptForKey(entry);
        return;
      }

      setNotice(
        `${entry.provider.displayName} has no API key env var configured.`,
      );
    },
    [entries, applyModel, promptForKey],
  );

  const keyBuffer = useTextBuffer({
    initialText: '',
    viewport: { width: 60, height: 1 },
    singleLine: true,
  });

  // When opening the key step with an existing key, seed the buffer so the
  // user sees it (masked in the label; buffer starts empty for security —
  // Enter reuses existing key, typing replaces).
  useEffect(() => {
    if (pendingKeyEntry) {
      keyBuffer.setText('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when entry changes
  }, [pendingKeyEntry]);

  const handleKeySubmit = useCallback(
    (value: string) => {
      const entry = pendingKeyEntry;
      if (!entry || !entry.provider.envKey) return;

      // Strip all whitespace/newlines from paste (Windows pastes often include \r).
      // writeEnvKey rejects keys with newlines and would crash the TUI uncaught.
      const typed = value.replace(/\s+/g, '').trim();
      const envKey = String(entry.provider.envKey);

      // Empty submit + existing key → keep existing key and switch model.
      const apiKey = typed || existingKey || '';
      if (!apiKey) {
        setNotice(
          `${entry.provider.displayName} requires ${envKey}. Paste your API key and press Enter.`,
        );
        return;
      }

      try {
        if (typed) {
          // Always write to ~/.openagent/.env — never project cwd / drive root.
          const envFile = getDefaultEnvFilePath();
          writeEnvKey(envFile, envKey, typed);
          process.env[envKey] = typed;
          setNotice(`Saved ${envKey} to ${envFile}`);
        }

        setPendingKeyEntry(null);
        setExistingKey(undefined);
        applyModel(entry);
      } catch (err) {
        // Never let setup crashes kill the process — stay on the key step.
        const msg = err instanceof Error ? err.message : String(err);
        setNotice(`Could not save key: ${msg}. Fix and press Enter again.`);
      }
    },
    [pendingKeyEntry, existingKey, applyModel],
  );

  useKeypress(
    (key) => {
      // Swallow Ctrl+C / Ctrl+D while in this dialog so global quit doesn't
      // fire mid-paste (users often Ctrl+C to copy, then paste into the box).
      if (
        (key.ctrl && (key.name === 'c' || key.name === 'd')) ||
        key.name === 'escape'
      ) {
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
          if (pendingKeyEntry) {
            setPendingKeyEntry(null);
            setExistingKey(undefined);
            setNotice(
              'Cancelled key entry. Select a model again or Esc to close.',
            );
            return true;
          }
          if (key.name === 'escape') {
            onClose();
            return true;
          }
        }
        // Ctrl+C with no key step: keep dialog open (global handler also sees it)
        return true;
      }
      return false;
    },
    { isActive: true, priority: true },
  );

  const currentModel = config?.getModel() ?? '';
  const currentProvider = currentModel
    ? resolveActiveProvider(currentModel)
    : undefined;

  return (
    <Box
      borderStyle="round"
      borderColor={theme.ui.focus}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Box>
        <Text color={theme.text.accent}>? </Text>
        <Text bold color={theme.text.primary}>
          OpenAgent setup
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.text.primary}>
          Pick a model from any provider (free / open-source / local / BYOK)
        </Text>
      </Box>
      {currentModel ? (
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            Current: {currentProvider?.displayName ?? 'unknown'} /{' '}
            {currentModel}
          </Text>
        </Box>
      ) : null}

      {pendingKeyEntry === null && (
        <>
          <Box marginTop={1}>
            <DescriptiveRadioButtonSelect
              items={items}
              onSelect={handleSelect}
              initialIndex={initialIndex}
              showNumbers={true}
              showScrollArrows={true}
              maxItemsToShow={12}
            />
          </Box>
          {notice !== '' && (
            <Box marginTop={1}>
              <Text color={theme.status.warning}>{notice}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              (Use Enter to select · Esc to close)
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              ✓ key ready · ✗ needs API key · after pick, paste key if asked
            </Text>
          </Box>
        </>
      )}

      {pendingKeyEntry !== null && (
        <Box marginTop={1} flexDirection="column">
          <Text>
            {pendingKeyEntry.provider.displayName} API key (
            {String(pendingKeyEntry.provider.envKey)}) for{' '}
            <Text bold>{pendingKeyEntry.model.key}</Text>
            {pendingKeyEntry.model.tier === 'free' ||
            pendingKeyEntry.model.tier === 'free_tier'
              ? ' (free models still require a provider API key)'
              : ''}
            :
          </Text>
          {existingKey ? (
            <Box marginTop={1}>
              <Text color={theme.status.success}>
                Found existing key: {maskKey(existingKey)} — press Enter to use
                it, or paste a new key to replace.
              </Text>
            </Box>
          ) : (
            <Box marginTop={1}>
              <Text color={theme.status.warning}>
                No {String(pendingKeyEntry.provider.envKey)} in .env — paste
                your API key below.
              </Text>
            </Box>
          )}
          <Box marginTop={1}>
            <TextInput
              buffer={keyBuffer}
              placeholder={
                existingKey
                  ? 'Enter to keep existing key, or paste a new one'
                  : 'paste key and press Enter (Esc to go back)'
              }
              onSubmit={handleKeySubmit}
              onCancel={() => {
                // Esc only — go back to model list, do not quit the app.
                setPendingKeyEntry(null);
                setExistingKey(undefined);
                setNotice('');
              }}
            />
          </Box>
          {notice !== '' && (
            <Box marginTop={1}>
              <Text color={theme.status.warning}>{notice}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              Paste key then Enter · Esc back · keys saved to ~/.openagent/.env
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
