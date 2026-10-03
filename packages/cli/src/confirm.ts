import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';

export async function confirmPush(input: Readable, output: Writable): Promise<boolean> {
  const terminal = createInterface({ input, output });
  const controller = new AbortController();
  terminal.once('close', () => controller.abort());
  try {
    const answer = await terminal.question('Apply changes? (y/N) ', { signal: controller.signal });
    return /^y(?:es)?$/i.test(answer.trim());
  } catch (error) {
    if (controller.signal.aborted) return false;
    throw error;
  } finally {
    terminal.close();
  }
}
