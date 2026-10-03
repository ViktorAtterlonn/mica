import { confirm, isCancel } from '@clack/prompts';
import type { Readable, Writable } from 'node:stream';

export async function confirmPush(input: Readable, output: Writable): Promise<boolean> {
  if (input.readableEnded || input.destroyed) return false;
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.once('end', abort);
  input.once('close', abort);
  try {
    const answer = await confirm({
      message: 'Apply changes?',
      initialValue: false,
      input,
      output,
      signal: controller.signal,
    });
    return !isCancel(answer) && answer;
  } finally {
    input.off('end', abort);
    input.off('close', abort);
  }
}
