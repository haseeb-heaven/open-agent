/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Settings wizard for web search providers: list backends, show which is
 * recommended for the active model, paste API keys, or open signup URLs
 * when the key field is empty.
 */

import type React from 'react';
import { useCallback, useContext, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import {
  listWebSearchProviders,
  planWebSearchRoute,
  writeEnvKey,
  getDefaultEnvFilePath,
  openBrowserSecurely,
  keyStatusLabel,
  type WebSearchProviderMeta,
} from '@open-agent/core';
import { useKeypress } from '../hooks/useKeypress.js';
import { theme } from '../semantic-colors.js';
import { DescriptiveRadioButtonSelect } from './shared/DescriptiveRadioButtonSelect.js';
import { TextInput } from './shared/TextInput.js';
import { useTextBuffer } from './shared/text-buffer.js';
import { ConfigContext } from '../contexts/ConfigContext.js';

interface WebSearchSettingsDialogProps {
  onClose: () => void;
}

function maskKey(key: string): string {
  const t = key.trim();
  if (t.length <= 8) return '••••••••';
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

export function WebSearchSettingsDialog({
  onClose,
}: WebSearchSettingsDialogProps): React.JSX.Element {
  const config = useContext(ConfigContext);
  const modelId = config?.getModel?.() ?? '';
  const plan = useMemo(() => planWebSearchRoute({ modelId }), [modelId]);

  const [selected, setSelected] = useState<WebSearchProviderMeta | null>(null);
  const [notice, setNotice] = useState('');
  const [existingKey, setExistingKey] = useState<string | undefined>();

  const keyBuffer = useTextBuffer({
    initialText: '',
    viewport: { width: 56, height: 1 },
    singleLine: true,
  });

  const items = useMemo(
    () =>
      plan.ranked.map((row) => {
        const keyLabel = keyStatusLabel(row.meta);
        const rec = row.recommended ? ' ★ RECOMMENDED' : '';
        return {
          value: row.meta.id,
          key: row.meta.id,
          title: `${row.meta.displayName}${rec}`,
          description: `${keyLabel} · ${row.meta.notes}`,
        };
      }),
    [plan.ranked],
  );

  const onSelectProvider = useCallback(
    (id: string) => {
      const backend = listWebSearchProviders().find((b) => b.meta.id === id);
      if (!backend) return;
      setSelected(backend.meta);
      setNotice('');
      if (backend.meta.envKey) {
        const k = process.env[backend.meta.envKey]?.trim();
        setExistingKey(k);
        keyBuffer.setText('');
      } else {
        setExistingKey(undefined);
        keyBuffer.setText('');
        setNotice(
          `${backend.meta.displayName} needs no API key. Esc to go back.`,
        );
      }
    },
    [keyBuffer],
  );

  const openSignup = useCallback(async () => {
    if (!selected?.signupUrl) {
      setNotice('No signup URL for this provider.');
      return;
    }
    try {
      await openBrowserSecurely(selected.signupUrl);
      setNotice(
        `Opened ${selected.signupUrl} — create a key, paste it, then Enter.`,
      );
    } catch (e) {
      setNotice(
        `Open manually: ${selected.signupUrl}\n(${e instanceof Error ? e.message : String(e)})`,
      );
    }
  }, [selected]);

  const saveKey = useCallback(async () => {
    if (!selected?.envKey) {
      onClose();
      return;
    }
    const raw = keyBuffer.text.trim();
    if (!raw) {
      await openSignup();
      return;
    }
    try {
      const envPath = getDefaultEnvFilePath();
      writeEnvKey(envPath, selected.envKey, raw);
      process.env[selected.envKey] = raw;
      setExistingKey(raw);
      setNotice(`Saved ${selected.envKey} to ${envPath}. Esc to close.`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }, [selected, keyBuffer.text, onClose, openSignup]);

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        if (selected) {
          setSelected(null);
          setNotice('');
          return;
        }
        onClose();
      }
    },
    { isActive: true },
  );

  if (selected) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.border.default}
        padding={1}
        width="100%"
      >
        <Text bold color={theme.text.accent}>
          Web search — {selected.displayName}
        </Text>
        <Text color={theme.text.secondary}>{selected.notes}</Text>
        <Text>
          Env: {selected.envKey ?? '(none)'}
          {existingKey ? ` · current ${maskKey(existingKey)}` : ''}
        </Text>
        {selected.envKey ? (
          <Box marginTop={1} flexDirection="column">
            <Text>API key (empty + Enter opens signup page):</Text>
            <TextInput
              buffer={keyBuffer}
              placeholder="paste key, or leave empty and Enter to open website"
              onSubmit={() => {
                void saveKey();
              }}
              onCancel={() => {
                setSelected(null);
                setNotice('');
              }}
            />
          </Box>
        ) : null}
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            Enter save/open · Esc back · signup: {selected.signupUrl ?? 'n/a'}
          </Text>
        </Box>
        {notice ? (
          <Box marginTop={1}>
            <Text color={theme.status.warning}>{notice}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border.default}
      padding={1}
      width="100%"
    >
      <Text bold color={theme.text.accent}>
        Web search providers
      </Text>
      <Text color={theme.text.secondary}>
        Model: {modelId || '(none)'} · Route: {plan.providerId ?? 'none'} —{' '}
        {plan.reason}
      </Text>
      <Box marginTop={1}>
        <DescriptiveRadioButtonSelect
          items={items}
          onSelect={onSelectProvider}
          initialIndex={0}
          showNumbers={false}
          showScrollArrows={true}
          maxItemsToShow={10}
        />
      </Box>
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          ★ recommended for this model · select to add key · Esc close
        </Text>
      </Box>
      {notice ? (
        <Box marginTop={1}>
          <Text color={theme.status.warning}>{notice}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
