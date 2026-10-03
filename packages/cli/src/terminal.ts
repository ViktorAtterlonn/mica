import { cancel, isCI, log, spinner } from '@clack/prompts';
import type { Readable, Writable } from 'node:stream';
import { confirmPush } from './confirm.js';

type OutputStyle = 'plain' | 'plan' | 'success' | 'cancel';

export interface CliIO {
  out(text: string, style?: OutputStyle): void;
  error(text: string): void;
  interactive: boolean;
  confirm?(): Promise<boolean>;
  progress?(message?: string): void;
}

export function createTerminal(
  input: Readable & { isTTY?: boolean } = process.stdin,
  output: Writable & { isTTY?: boolean } = process.stdout,
  error: Writable = process.stderr,
): CliIO {
  const interactive = Boolean(input.isTTY && output.isTTY && !isCI());
  const progress = spinner({ output, onCancel: () => process.exit(130) });
  return {
    interactive,
    out(text, style = 'plain') {
      if (!interactive || style === 'plain') {
        output.write(`${text}\n`);
        return;
      }
      if (style === 'cancel') cancel(text, { output });
      else if (style === 'success') log.success(text, { output });
      else log.message(text, { output });
    },
    error(text) {
      if (interactive) log.error(text, { output: error });
      else error.write(`${text}\n`);
    },
    confirm: () => confirmPush(input, output),
    progress(message) {
      if (!interactive) return;
      if (message) progress.start(message);
      else progress.clear();
    },
  };
}
