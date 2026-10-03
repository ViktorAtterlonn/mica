import { MongoClient } from 'mongodb';
import { loadConfig } from './config.js';
import { renderCheck, renderDiff } from './render.js';
import type { CliIO } from './terminal.js';
import { applySchemaDiff, compareSchemas, introspectDatabase } from '@mica/db/tooling';

interface CommandOptions {
  command: 'check' | 'diff' | 'push';
  json: boolean;
  yes: boolean;
}

/** 0 success, 1 drift/blocked/cancelled push, 2 configuration/connection/operation error. */
export async function runSchemaCommand(
  options: CommandOptions,
  io: CliIO,
  cwd: string,
): Promise<number> {
  const { command, json, yes } = options;
  const interactiveOutput = io.interactive && command !== 'check' && !json && !yes;
  let client: MongoClient | undefined;
  try {
    if (interactiveOutput) io.progress?.('Inspecting database schema');
    const { config, desired } = await loadConfig(cwd);
    client = new MongoClient(config.database.uri, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    const db = client.db(config.database.name);
    const actual = await introspectDatabase(
      db,
      desired.collections.map((c) => c.name),
    );
    const diff = compareSchemas(desired, actual);
    if (interactiveOutput) io.progress?.();
    let output: string;
    if (json) output = JSON.stringify(diff, null, 2);
    else if (command === 'check') output = renderCheck(diff);
    else output = renderDiff(diff, command);
    io.out(output, interactiveOutput ? 'plan' : 'plain');
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
        io.out('Cancelled. No changes were applied.', 'cancel');
        return 1;
      }
    }
    if (interactiveOutput) io.progress?.('Applying schema changes');
    const remaining = await applySchemaDiff(db, diff);
    if (interactiveOutput) io.progress?.();
    if (remaining.changes.length) {
      io.error('Push finished but schema drift remains. Run mica diff to inspect it.');
      return 1;
    }
    io.out('Schema matches after push.', interactiveOutput ? 'success' : 'plain');
    return 0;
  } catch (error) {
    if (interactiveOutput) io.progress?.();
    const message = error instanceof Error ? error.message : String(error);
    const redacted = message.replace(/mongodb(?:\+srv)?:\/\/[^\s'"`]+/g, '[MongoDB URI]');
    io.error(`Mica: ${redacted}`);
    return 2;
  } finally {
    await client?.close();
  }
}
