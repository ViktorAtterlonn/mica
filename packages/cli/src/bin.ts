#!/usr/bin/env node
import { confirmPush } from './confirm.js';
import { runCli } from './run.js';

process.exitCode = await runCli(process.argv.slice(2), {
  out: (text) => console.log(text),
  error: (text) => console.error(text),
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  confirm: () => confirmPush(process.stdin, process.stdout),
});
