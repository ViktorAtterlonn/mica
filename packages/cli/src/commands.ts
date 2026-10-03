import {
  defineCommand,
  parseArgs,
  renderUsage,
  runCommand,
  type ArgsDef,
  type ParsedArgs,
} from 'citty';
import { runSchemaCommand } from './run.js';
import type { CliIO } from './terminal.js';

const help = { type: 'boolean', description: 'Show usage' } as const;
const readArgs = {
  help,
  json: { type: 'boolean', description: 'Output the structured schema diff' },
} as const;
const pushArgs = {
  help,
  yes: { type: 'boolean', description: 'Apply planned changes without confirmation' },
} as const;

// Citty permits undeclared options; reject them before config loading or database access.
function validateOptions(args: ParsedArgs, definitions: ArgsDef): void {
  for (const name of Object.keys(args)) {
    if (name !== '_' && !Object.hasOwn(definitions, name))
      throw new Error(`Unknown option: --${name}`);
  }
}

/** Citty owns parsing, subcommand dispatch, and help generation; Mica owns exit codes. */
export async function runCli(rawArgs: string[], io: CliIO, cwd = process.cwd()): Promise<number> {
  let exitCode = 0;
  let showHelp = false;
  const meta = { name: 'mica', description: 'MongoDB schema tooling' };
  const subCommands = {
    check: command('check', 'Check whether the database schema is synchronized', readArgs),
    diff: command('diff', 'Show schema differences without modifying the database', readArgs),
    push: command('push', 'Review and apply schema changes', pushArgs),
  };
  const main = defineCommand({
    meta,
    args: { help },
    subCommands,
    setup({ args, rawArgs }) {
      showHelp = args.help === true;
      // Only help is global. Command options belong after the subcommand.
      const commandIndex = args._.length ? rawArgs.indexOf(args._[0]!) : rawArgs.length;
      validateOptions(parseArgs(rawArgs.slice(0, commandIndex), { help }), { help });
    },
    async run({ args }) {
      if (args._.length) return;
      if (!showHelp) throw new Error('Choose a command: mica check, mica diff, or mica push');
      io.out(await renderUsage(main));
    },
  });

  function command(name: 'check' | 'diff' | 'push', description: string, definitions: ArgsDef) {
    return defineCommand({
      meta: { name, description },
      args: definitions,
      async run({ args, cmd }) {
        validateOptions(args, definitions);
        if (args._.length) throw new Error(`Unexpected arguments: ${args._.join(' ')}`);
        if (showHelp) {
          io.out(await renderUsage(cmd, { meta }));
          return;
        }
        exitCode = await runSchemaCommand(
          { command: name, json: args.json === true, yes: args.yes === true },
          io,
          cwd,
        );
      },
    });
  }

  try {
    await runCommand(main, { rawArgs });
    return exitCode;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
