#!/usr/bin/env node
import { runCli } from './commands.js';
import { createTerminal } from './terminal.js';

process.exitCode = await runCli(process.argv.slice(2), createTerminal());
