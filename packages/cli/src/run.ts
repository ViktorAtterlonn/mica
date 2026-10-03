import { MongoClient } from 'mongodb';
import { parseArguments, usage } from './arguments.js';
import { loadConfig } from './config.js';
import { renderDiff } from './render.js';
import { applySchemaDiff, compareSchemas, introspectDatabase } from '@mica/db/tooling';

export interface CliIO {
  out(text: string): void;
  error(text: string): void;
  interactive: boolean;
  confirm?(): Promise<boolean>;
}

/** 0 success, 1 drift/blocked/cancelled push, 2 configuration/connection/operation error. */
export async function runCli(args: string[], io: CliIO, cwd = process.cwd()): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    io.out(usage);
    return 0;
  }
  const options = parseArguments(args);
  if (!options) {
    io.error(usage);
    return 2;
  }
  const { command, json, yes } = options;
  let client: MongoClient | undefined;
  try {
    const { config, desired } = await loadConfig(cwd);
    client = new MongoClient(config.database.uri, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    const db = client.db(config.database.name);
    const actual = await introspectDatabase(
      db,
      desired.collections.map((c) => c.name),
    );
    const diff = compareSchemas(desired, actual);
    io.out(json ? JSON.stringify(diff, null, 2) : renderDiff(diff, command));
    if (command === 'check') return diff.changes.length ? 1 : 0;
    if (command === 'diff' || !diff.changes.length) return 0;
    if (diff.changes.some((change) => change.kind === 'unsupported')) {
      io.error('Unsupported configuration blocks push. No changes were applied.');
      return 1;
    }
    if (!yes) {
      if (!io.interactive || !io.confirm) {
        io.error('Push requires interactive confirmation or --yes. No changes were applied.');
        return 1;
      }
      if (!(await io.confirm())) {
        io.out('Cancelled. No changes were applied.');
        return 1;
      }
    }
    const remaining = await applySchemaDiff(db, diff);
    if (remaining.changes.length) {
      io.error('Push finished but schema drift remains. Run mica diff to inspect it.');
      return 1;
    }
    io.out('Schema matches after push.');
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const redacted = message.replace(/mongodb(?:\+srv)?:\/\/[^\s'"`]+/g, '[MongoDB URI]');
    io.error(`Mica: ${redacted}`);
    return 2;
  } finally {
    await client?.close();
  }
}
