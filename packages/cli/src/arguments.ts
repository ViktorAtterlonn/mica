export type CliCommand = 'check' | 'diff' | 'push';

export interface CliArguments {
  command: CliCommand;
  json: boolean;
  yes: boolean;
}

export const usage =
  'Usage: mica check [--json]\n       mica diff [--json]\n       mica push [--yes]';

export function parseArguments(args: string[]): CliArguments | undefined {
  const [command, ...flags] = args;
  if (command !== 'check' && command !== 'diff' && command !== 'push') return;
  if (flags.length > 1) return;

  const allowedFlag = command === 'push' ? '--yes' : '--json';
  if (flags.some((flag) => flag !== allowedFlag)) return;

  return { command, json: flags.includes('--json'), yes: flags.includes('--yes') };
}
