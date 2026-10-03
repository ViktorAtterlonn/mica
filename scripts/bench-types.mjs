import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { writeConsumer } from './consumer-fixture.mjs';
import { packPackage } from './pack.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const versions = ['5.9.3', '6.0.3', '7.0.2'];
const args = process.argv.slice(2);
assert(
  args.length === 0 || (args.length === 1 && args[0] === '--matrix'),
  'Use --matrix or no arguments',
);
const selected = args.length ? versions : [process.env.MICA_TYPESCRIPT ?? versions.at(-1)];
assert(
  selected.every((version) => versions.includes(version)),
  'MICA_TYPESCRIPT must be a tested version',
);
const resultsDirectory = join(root, '.tmp', 'type-bench');
mkdirSync(resultsDirectory, { recursive: true });

// Compile the same public contract fixtures/examples against installed declarations.
function copyFixtures(source, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) copyFixtures(from, to);
    else if (entry.name.endsWith('.ts')) {
      writeFileSync(
        to,
        readFileSync(from, 'utf8').replace(
          /(['"])(?:\.\.\/)+packages\/db\/src\/index\.js\1/g,
          "'@mica/db'",
        ),
      );
    }
  }
}

for (const version of selected) {
  const temporary = mkdtempSync(join(tmpdir(), 'mica-consumer-'));
  const results = [];
  const report = {
    node: process.version,
    typescript: version,
    mongodb: '7.7.0',
    results,
    passed: false,
  };
  try {
    const packed = packPackage('db', temporary);
    writeFileSync(
      join(temporary, 'package.json'),
      JSON.stringify({
        private: true,
        type: 'module',
        dependencies: {
          '@mica/db': `file:./${packed.filename}`,
          mongodb: report.mongodb,
          typescript: version,
          '@types/node': '22.20.4',
        },
      }),
    );
    execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: temporary,
      stdio: 'inherit',
      timeout: 180_000,
    });
    writeFileSync(
      join(resultsDirectory, `typescript-${version}.lock.json`),
      readFileSync(join(temporary, 'package-lock.json')),
    );
    for (const [name, expected] of [
      ['typescript', version],
      ['mongodb', report.mongodb],
    ]) {
      assert.equal(
        JSON.parse(readFileSync(join(temporary, 'node_modules', name, 'package.json'), 'utf8'))
          .version,
        expected,
      );
    }
    writeFileSync(
      join(temporary, 'runtime.mjs'),
      `
import assert from 'node:assert/strict';
import { collection, createDatabase, jsonSchema, string } from '@mica/db';
const Records = collection('records', { _id: string() });
assert.equal(jsonSchema(Records).$jsonSchema.properties._id.bsonType, 'string');
const db = createDatabase({ uri: 'mongodb://127.0.0.1:1', database: 'unused', collections: { records: Records } });
assert.equal(db.status, 'idle');
await db.close();
`,
    );
    execFileSync(process.execPath, [join(temporary, 'runtime.mjs')], { stdio: 'inherit' });
    const options = {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: false,
      noEmit: true,
      types: ['node'],
    };

    function compile(name, directory, include) {
      writeFileSync(
        join(directory, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: options, include }),
      );
      const start = performance.now();
      let diagnostics;
      try {
        diagnostics = execFileSync(
          join(temporary, 'node_modules', '.bin', 'tsc'),
          ['--project', join(directory, 'tsconfig.json'), '--extendedDiagnostics'],
          { cwd: temporary, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
        );
      } catch (error) {
        const output = error.stdout?.toString() ?? error.message;
        results.push({ name, passed: false, diagnostics: output });
        console.error(output);
        throw error;
      }
      const metric = (label) => {
        const match = diagnostics.match(new RegExp(`^${label}:\\s+([\\d.]+)`, 'm'));
        assert(match, `Missing compiler diagnostic: ${label}`);
        return Number(match[1]);
      };
      const result = {
        name,
        wallMs: Math.round(performance.now() - start),
        types: metric('Types'),
        instantiations: metric('Instantiations'),
        memoryKib: metric('Memory used'),
        diagnostics,
      };
      results.push(result);
      console.log(
        `TypeScript ${version}, ${name}: ${result.wallMs}ms, ${result.instantiations} instantiations, ${Math.round(result.memoryKib / 1024)} MiB`,
      );
      // Measured baselines and headroom are documented in docs/compatibility.md.
      const budget =
        name === 'public-contracts'
          ? 1_000_000
          : name.startsWith('1-')
            ? 800_000
            : version === '7.0.2'
              ? 8_000_000
              : 4_000_000;
      assert(result.instantiations < budget, `${name}: type instantiations exceed ${budget}`);
      assert(result.memoryKib < 1_310_720, `${name}: compiler memory exceeds 1.25 GiB`);
    }

    const contracts = join(temporary, 'contracts');
    copyFixtures(join(root, 'examples'), join(contracts, 'examples'));
    mkdirSync(join(contracts, 'tests'), { recursive: true });
    for (const name of readdirSync(join(root, 'tests')).filter(
      (name) => name === 'types.ts' || name.endsWith('.types.ts'),
    )) {
      writeFileSync(
        join(contracts, 'tests', name),
        readFileSync(join(root, 'tests', name), 'utf8').replaceAll(
          "'../packages/db/src/index.js'",
          "'@mica/db'",
        ),
      );
    }
    compile('public-contracts', contracts, ['**/*.ts']);

    for (const count of [1, 100]) {
      for (const depth of [3, 5, 8]) {
        const name = `${count}-entities-depth-${depth}`;
        const directory = join(temporary, name);
        writeConsumer(directory, count, depth);
        compile(name, directory, ['**/*.ts']);
      }
    }
    report.passed = true;
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    writeFileSync(
      join(resultsDirectory, `typescript-${version}.json`),
      JSON.stringify(report, null, 2),
    );
    rmSync(temporary, { recursive: true, force: true });
  }
}
