import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { confirmPush } from '../packages/cli/src/confirm.js';
import { runCli, type CliIO } from '../packages/cli/src/run.js';

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
  assert.match(output[0]!, /mica check/);
  for (const args of [
    [],
    ['pull'],
    ['check', '--yes'],
    ['push', '--json'],
    ['push', '-y'],
    ['check', '--json', '--json'],
  ])
    assert.equal(await runCli(args, io), 2);
  assert.equal(errors.length, 6);
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

test('terminal confirmation defaults to No, accepts only yes, and cancels at EOF', async () => {
  for (const [answer, expected] of [
    ['', false],
    ['n', false],
    ['maybe', false],
    ['Y', true],
    ['yes', true],
    [null, false],
  ] as const) {
    const input = new PassThrough();
    const output = new PassThrough();
    const response = confirmPush(input, output);
    if (answer === null) input.end();
    else input.write(`${answer}\n`);
    assert.equal(await response, expected);
    assert.match(output.read().toString(), /Apply changes\? \(y\/N\)/);
    input.destroy();
    output.destroy();
  }
});
