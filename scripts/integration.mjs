import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { MongoClient } from 'mongodb';
import { setTimeout } from 'node:timers/promises';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--generated'))
  throw new Error('Usage: node scripts/integration.mjs [--generated]');
const generatedOnly = args[0] === '--generated';

// A fresh, uniquely named container; never attaches to or modifies an existing database.
const container = `mica-test-${randomUUID()}`;
const image = process.env.MICA_MONGO_IMAGE ?? 'mongo:8.2.2';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
let created = false;
try {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const selectedPort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  docker(
    'run',
    '-d',
    '--name',
    container,
    '-p',
    `127.0.0.1:${selectedPort}:27017`,
    image,
    '--bind_ip_all',
    '--setParameter',
    'enableTestCommands=1',
    '--replSet',
    'mica',
  );
  created = true;
  const port = docker('port', container, '27017/tcp').split(':').at(-1);
  const uri = `mongodb://127.0.0.1:${port}/?directConnection=true`;
  const bootstrap = new MongoClient(uri);
  try {
    await bootstrap.connect();
    await bootstrap.db('admin').command({
      replSetInitiate: { _id: 'mica', members: [{ _id: 0, host: '127.0.0.1:27017' }] },
    });
    const deadline = Date.now() + 30_000;
    while (!(await bootstrap.db('admin').command({ hello: 1 })).isWritablePrimary) {
      if (Date.now() > deadline)
        throw new Error('Disposable replica set did not elect its primary');
      await setTimeout(100);
    }
  } finally {
    await bootstrap.close();
  }
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--test',
      '--test-concurrency=1',
      ...(generatedOnly
        ? []
        : [
            'tests/mongodb.integration.ts',
            'tests/field-options.integration.ts',
            'tests/queries.integration.ts',
            'tests/chunks.integration.ts',
            'tests/update-operators.integration.ts',
            'tests/distinct-ttl.integration.ts',
            'tests/capabilities.integration.ts',
            'tests/hardening.integration.ts',
            'tests/workflow.integration.ts',
            'tests/feature-gaps.integration.ts',
            'tests/aggregation.integration.ts',
          ]),
      'tests/generated-contracts.integration.ts',
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        MICA_TEST_URI: uri,
        MICA_TEST_CONTAINER: container,
      },
    },
  );
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  const code = await new Promise((resolve) => child.on('exit', resolve));
  process.exitCode = code ?? 1;
} finally {
  if (created) docker('rm', '-fv', container);
}
