/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { performInit, DEFAULT_CONTEXT_FILENAME } from '@open-agent/core';
import type {
  Command,
  CommandContext,
  CommandExecutionResponse,
} from './types.js';

export class InitCommand implements Command {
  name = 'init';
  description = `Analyzes the project and creates a tailored ${DEFAULT_CONTEXT_FILENAME} file`;
  requiresWorkspace = true;

  async execute(
    context: CommandContext,
    _args: string[] = [],
  ): Promise<CommandExecutionResponse> {
    const targetDir = context.agentContext.config.getTargetDir();
    if (!targetDir) {
      throw new Error('Command requires a workspace.');
    }

    const contextFilePath = path.join(targetDir, DEFAULT_CONTEXT_FILENAME);
    const result = performInit(fs.existsSync(contextFilePath));

    switch (result.type) {
      case 'message':
        return {
          name: this.name,
          data: result,
        };
      case 'submit_prompt':
        fs.writeFileSync(contextFilePath, '', 'utf8');

        if (typeof result.content !== 'string') {
          throw new Error('Init command content must be a string.');
        }

        // Inform the user since we can't trigger the UI-based interactive agent loop here directly.
        // We output the prompt text they can use to re-trigger the generation manually,
        // or just seed the context file as we've done above.
        return {
          name: this.name,
          data: {
            type: 'message',
            messageType: 'info',
            content: `A template ${DEFAULT_CONTEXT_FILENAME} has been created at ${contextFilePath}.\n\nTo populate it with project context, you can run the following prompt in a new chat:\n\n${result.content}`,
          },
        };

      default:
        throw new Error('Unknown result type from performInit');
    }
  }
}
