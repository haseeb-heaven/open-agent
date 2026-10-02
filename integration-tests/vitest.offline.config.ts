/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 300000,
    globalSetup: './globalSetup.ts',
    reporters: ['json'],
    include: ['**/*.test.ts'],
    retry: 0,
    fileParallelism: false,
    maxWorkers: 1,
    env: { GEMINI_TEST_TYPE: 'integration' },
  },
});
