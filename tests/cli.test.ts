import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { confirmPush } from '../packages/cli/src/confirm.js';
import { runCli } from '../packages/cli/src/commands.js';
import { createTerminal, type CliIO } from '../packages/cli/src/terminal.js';

function capture() {
  const output: string[] = [],
    errors: string[] = [];
  const io: CliIO = {
    out: (s) => output.push(s),
    error: (s) => errors.push(s),
    interactive: false,
  };
  return { output, errors, io };
}

test('CLI help and invalid command/flag errors are distinct from drift', async () => {
  const { io, output, errors } = capture();
  assert.equal(await runCli(['--help'], io), 0);
  assert.match(output[0]!, /check/);
  assert.match(output[0]!, /diff/);
  assert.match(output[0]!, /push/);
  for (const args of [
    [],
    ['pull'],
    ['check', '--yes'],
    ['push', '--json'],
    ['push', '-y'],
    ['-h'],
    ['check', 'extra'],
    ['push', '--force'],
    ['push', '--yes', 'extra'],
    ['--yes', 'push'],
    ['--help', 'pull'],
  ])
    assert.equal(await runCli(args, io), 2);
  assert.equal(errors.length, 11);
  for (const error of errors)
    assert.match(error, /Unknown option|Unknown command|Unexpected arguments|Choose a command/);
});

test('missing and invalid configuration produces exit 2', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mica-config-'));
  try {
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    const { io, errors } = capture();
    assert.equal(await runCli(['check'], io, dir), 2);
    assert.match(errors[0]!, /mica.config.ts/);
    await writeFile(
      join(dir, 'mica.config.ts'),
      'export default { schema: "./schema.ts", database: { uri: "", name: "test" } };',
    );
    assert.equal(await runCli(['check'], io, dir), 2);
    assert.match(errors[1]!, /database.uri/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('connection failures are reported as tool errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mica-connection-'));
  try {
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    await writeFile(
      join(dir, 'mica.config.ts'),
      'export default { schema: "./schema.ts", database: { uri: "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=1", name: "test" } };',
    );
    await writeFile(
      join(dir, 'schema.ts'),
      `import { collection } from ${JSON.stringify(new URL('../packages/db/src/schema.ts', import.meta.url).href)}; import { string } from ${JSON.stringify(new URL('../packages/db/src/fields.ts', import.meta.url).href)}; export default { records: collection('records', { _id: string() }) };`,
    );
    const { io, errors } = capture();
    assert.equal(await runCli(['check'], io, dir), 2);
    assert.match(errors[0]!, /ECONNREFUSED|Server selection/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CommonJS configuration receives an actionable ESM requirement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mica-commonjs-'));
  try {
    await writeFile(
      join(dir, 'mica.config.ts'),
      'export default { schema: "./schema.ts", database: { uri: "mongodb://127.0.0.1:1", name: "test" } };',
    );
    const { io, errors } = capture();
    assert.equal(await runCli(['check'], io, dir), 2);
    assert.match(errors[0]!, /ESM project/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  'Clack confirmation defaults to No and handles keyboard acceptance and cancellation',
  { timeout: 3000 },
  async () => {
    for (const [keys, expected] of [
      ['\r', false],
      ['n', false],
      ['y', true],
      ['\u001b[C\r', true],
      ['\u0003', false],
      [null, false],
    ] as const) {
      const input = new PassThrough();
      const output = new PassThrough();
      const response = confirmPush(input, output);
      if (keys === null) input.end();
      else input.write(keys);
      assert.equal(await response, expected);
      assert.match(output.read().toString(), /Apply changes\?/);
      input.destroy();
      output.destroy();
    }
  },
);

test('Citty generates command-specific help without loading configuration', async () => {
  for (const command of ['check', 'diff', 'push']) {
    const { io, output, errors } = capture();
    assert.equal(await runCli([command, '--help'], io, '/missing-config'), 0);
    assert.match(output[0]!, new RegExp(`mica ${command}`));
    assert.match(output[0]!, command === 'push' ? /--yes/ : /--json/);
    assert.doesNotMatch(output[0]!, command === 'push' ? /--json|-y,/ : /--yes/);
    assert.deepEqual(errors, []);
    assert.equal(await runCli(['--help', command], io, '/missing-config'), 0);
  }
});

test('redirected terminal output is plain and progress stays silent', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  const io = createTerminal(input, output, errors);
  assert.equal(io.interactive, false);
  io.progress?.('Inspecting database schema');
  io.progress?.();
  io.out('Plan', 'plan');
  io.out('Done', 'success');
  io.error('Failure');
  assert.equal(output.read().toString(), 'Plan\nDone\n');
  assert.equal(errors.read().toString(), 'Failure\n');
  input.destroy();
  output.destroy();
  errors.destroy();
});
