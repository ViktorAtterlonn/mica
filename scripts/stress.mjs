import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { packPackage } from './pack.mjs';

const mode = process.argv[2];
assert(
  process.argv.length === 3 && ['load', 'recovery'].includes(mode),
  'Use stress.mjs load|recovery',
);
const root = fileURLToPath(new URL('..', import.meta.url));
const run = `mica-stress-${randomUUID()}`;
const members = Array.from({ length: mode === 'recovery' ? 3 : 1 }, (_, i) => `${run}-${i}`);
const runner = `${run}-client`;
const image = process.env.MICA_MONGO_IMAGE ?? 'mongo:8.2.2';
const nodeImage = 'node:22.13.0';
const stage = mkdtempSync(join(tmpdir(), 'mica-stress-'));
const reportDirectory = join(root, '.tmp', 'stress', `${mode}-${Date.now()}`);
mkdirSync(reportDirectory, { recursive: true });
const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000 }).trim();
let networkCreated = false;
let child;
let interrupted = false;
const created = [];
const manifest = {
  mode,
  image,
  nodeImage,
  startedAt: new Date().toISOString(),
  passed: false,
  faults: [],
};
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    interrupted = true;
    child?.kill(signal);
  });

try {
  const packed = packPackage('db', stage);
  const databaseManifest = JSON.parse(readFileSync(join(root, 'packages/db/package.json'), 'utf8'));
  writeFileSync(
    join(stage, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: {
        '@mica/db': `file:./${packed.filename}`,
        mongodb: databaseManifest.dependencies.mongodb,
      },
    }),
  );
  execFileSync(
    'npm',
    ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: stage, stdio: 'pipe' },
  );
  cpSync(join(root, 'tests', 'stress'), join(stage, 'tests', 'stress'), { recursive: true });
  mkdirSync(join(stage, 'control'));
  docker('network', 'create', run);
  networkCreated = true;
  for (const member of members) {
    if (interrupted) throw new Error('Interrupted');
    docker(
      'run',
      '-d',
      '--name',
      member,
      '--network',
      run,
      image,
      '--bind_ip_all',
      '--replSet',
      'mica',
      '--wiredTigerCacheSizeGB',
      '0.25',
      '--setParameter',
      'enableTestCommands=1',
    );
    created.push(member);
  }
  // A running container does not imply that mongod is accepting connections yet.
  for (const member of members) {
    const deadline = Date.now() + 30_000;
    while (true) {
      if (interrupted) throw new Error('Interrupted');
      try {
        docker('exec', member, 'mongosh', '--quiet', '--eval', 'db.adminCommand({ ping: 1 })');
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await delay(250);
      }
    }
  }
  const config = {
    _id: 'mica',
    members: members.map((host, _id) => ({ _id, host: `${host}:27017` })),
    settings: { electionTimeoutMillis: 2000 },
  };
  docker(
    'exec',
    members[0],
    'mongosh',
    '--quiet',
    '--eval',
    `
    const deadline = Date.now() + 60000;
    const initiated = rs.initiate(${JSON.stringify(config)});
    if (!initiated.ok) throw new Error(JSON.stringify(initiated));
    while (true) {
      const status = rs.status();
      if (status.members.filter(m => m.state === 1).length === 1 && status.members.every(m => [1, 2].includes(m.state))) break;
      if (Date.now() > deadline) throw new Error('Replica set did not become ready');
      sleep(200);
    }
  `,
  );
  manifest.mongoImageId = docker('inspect', '--format', '{{.Image}}', members[0]);
  manifest.dockerCpuCount = Number(docker('info', '--format', '{{.NCPU}}'));
  manifest.dockerMemoryBytes = Number(docker('info', '--format', '{{.MemTotal}}'));
  console.log(
    `Running ${mode} against ${members.length} disposable MongoDB member(s). Reports: ${reportDirectory}`,
  );
  const uri = `mongodb://${members.map((m) => `${m}:27017`).join(',')}/?replicaSet=mica&retryWrites=true&w=majority`;
  child = spawn(
    'docker',
    [
      'run',
      '--rm',
      '--name',
      runner,
      '--network',
      run,
      '-v',
      `${stage}:/work`,
      '-w',
      '/work',
      '-e',
      `MICA_STRESS_URI=${uri}`,
      '-e',
      `MICA_STRESS_MEMBERS=${JSON.stringify(members)}`,
      ...[
        'MICA_LOAD_SECONDS',
        'MICA_LOAD_WORKERS',
        'MICA_LOAD_DOCUMENTS',
        'MICA_LOAD_PAYLOAD_BYTES',
      ].flatMap((key) => (process.env[key] ? ['-e', `${key}=${process.env[key]}`] : [])),
      nodeImage,
      'sh',
      '-c',
      `npm ci --omit=dev --ignore-scripts --no-audit --no-fund && node --expose-gc tests/stress/${mode}.mjs`,
    ],
    { stdio: 'inherit' },
  );
  let exited = false;
  const completion = new Promise((resolve) => {
    child.on('error', (error) => {
      exited = true;
      manifest.childError = error.message;
      resolve(1);
    });
    child.on('exit', (code) => {
      exited = true;
      resolve(code);
    });
  });
  const deadline = Date.now() + (mode === 'load' ? 25 * 60_000 : 5 * 60_000);
  while (!exited) {
    if (interrupted || Date.now() > deadline)
      throw new Error(interrupted ? 'Interrupted' : 'Stress runner timed out');
    const requestFile = join(stage, 'control', 'request.json');
    if (existsSync(requestFile)) {
      const request = JSON.parse(readFileSync(requestFile, 'utf8'));
      assert(members.includes(request.member), 'Only this run’s own containers may be controlled');
      assert(['kill', 'start'].includes(request.action), 'Unknown fault action');
      const started = Date.now();
      docker(request.action, request.member);
      manifest.faults.push({ ...request, elapsedMs: Date.now() - started });
      rmSync(requestFile);
      writeFileSync(
        join(stage, 'control', 'response.tmp'),
        JSON.stringify({ id: request.id, ok: true }),
      );
      renameSync(join(stage, 'control', 'response.tmp'), join(stage, 'control', 'response.json'));
    }
    await delay(100);
  }
  assert.equal(await completion, 0, `${mode} checks failed`);
  manifest.passed = true;
} catch (error) {
  manifest.error = error.message;
  process.exitCode = 1;
  console.error(error);
} finally {
  if (existsSync(join(stage, 'report.json')))
    cpSync(join(stage, 'report.json'), join(reportDirectory, 'results.json'));
  for (const member of created) {
    try {
      writeFileSync(
        join(reportDirectory, `${member.slice(-1)}.log`),
        docker('logs', '--tail', '150', member),
      );
    } catch {
      /* Preserve the original failure. */
    }
  }
  try {
    if (docker('ps', '-aq', '--filter', `name=^/${runner}$`)) docker('rm', '-fv', runner);
  } catch {
    /* --rm may already have removed it. */
  }
  for (const member of created.reverse()) {
    try {
      docker('rm', '-fv', member);
    } catch (error) {
      manifest.cleanupError = error.message;
      process.exitCode = 1;
    }
  }
  if (networkCreated) {
    try {
      docker('network', 'rm', run);
    } catch (error) {
      manifest.cleanupError = error.message;
      process.exitCode = 1;
    }
  }
  manifest.passed = manifest.passed && !manifest.cleanupError;
  manifest.finishedAt = new Date().toISOString();
  writeFileSync(join(reportDirectory, 'run.json'), JSON.stringify(manifest, null, 2));
  rmSync(stage, { recursive: true, force: true });
  console.log(`Stress report: ${reportDirectory}`);
}
