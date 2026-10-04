/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';

interface UseModelCommandReturn {
  isModelDialogOpen: boolean;
  openModelDialog: () => void;
  closeModelDialog: () => void;
}

/**
 * @param openOnStart When true, open the multi-model picker on first render
 * (used instead of the old single-line "Enter NVIDIA API key" console prompt).
 */
export const useModelCommand = (openOnStart = false): UseModelCommandReturn => {
  const [isModelDialogOpen, setIsModelDialogOpen] = useState(openOnStart);

  const openModelDialog = useCallback(() => {
    setIsModelDialogOpen(true);
  }, []);

  const closeModelDialog = useCallback(() => {
    setIsModelDialogOpen(false);
  }, []);

  return {
    isModelDialogOpen,
    openModelDialog,
    closeModelDialog,
  };
};
