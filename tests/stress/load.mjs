import assert from 'node:assert/strict';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Binary } from 'mongodb';
import {
  collection,
  createDatabase,
  customType,
  index,
  jsonSchema,
  number,
  string,
} from '../../dist/index.js';
import { client, poolMetrics, report, save, scenario } from './shared.mjs';

function setting(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  assert(
    Number.isSafeInteger(value) && value >= min && value <= max,
    `${name} must be ${min}–${max}`,
  );
  return value;
}
const config = {
  seconds: setting('MICA_LOAD_SECONDS', 30, 6, 1200),
  workers: setting('MICA_LOAD_WORKERS', 8, 1, 64),
  documents: setting('MICA_LOAD_DOCUMENTS', 2000, 100, 100_000),
  payloadBytes: setting('MICA_LOAD_PAYLOAD_BYTES', 8192, 0, 262144),
};
assert(
  config.documents * config.payloadBytes <= 256 * 1024 * 1024,
  'Seed data must not exceed 256 MiB',
);
report.config = config;
const encoded = customType({
  base: string,
  codec: {
    storedSchema: { bsonType: 'binData' },
    encode: (value) => new Binary(Buffer.from(value)),
    decode: (value) => Buffer.from(value.value()).toString(),
  },
});
const Records = collection(
  'records',
  {
    _id: string(),
    category: number(),
    score: number(),
    payload: encoded(),
  },
  (t) => [index('category').on(t.category)],
);
const Large = collection('large', { _id: string(), payload: encoded() });
const connection = client({ maxPoolSize: config.workers });
const pools = poolMetrics(connection);
const db = createDatabase({
  client: connection,
  database: 'mica_load',
  collections: { records: Records, large: Large },
});
const loop = monitorEventLoopDelay({ resolution: 20 });
const peak = process.memoryUsage();
const sample = () => {
  for (const [key, value] of Object.entries(process.memoryUsage()))
    peak[key] = Math.max(peak[key], value);
};
const sampler = setInterval(sample, 20);
let increments = 0;

// Logarithmic histogram: bounded memory, percentile bucket upper bounds within ~0.7% + 0.01ms.
function histogram() {
  const buckets = new Map();
  let total = 0;
  return {
    add(ms) {
      const key = Math.ceil(Math.log2(1 + ms) * 100);
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
      total++;
    },
    result() {
      const percentile = (p) => {
        let count = 0;
        for (const [key, n] of [...buckets].sort((a, b) => a[0] - b[0])) {
          count += n;
          if (count >= Math.ceil(total * p)) return Number((2 ** (key / 100) - 1).toFixed(2));
        }
        return 0;
      };
      return {
        count: total,
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
        p99Ms: percentile(0.99),
      };
    },
  };
}

try {
  await db.connect();
  report.mongo = (await connection.db('admin').command({ buildInfo: 1 })).version;
  for (const schema of [Records, Large]) {
    const raw = await connection
      .db('mica_load')
      .createCollection(schema.$name, { validator: jsonSchema(schema) });
    if (schema.$indexes.length) await raw.createIndexes(schema.$indexes);
  }
  const payload = 'x'.repeat(config.payloadBytes);
  for (let offset = 0; offset < config.documents; offset += 100) {
    await db.records.insertMany(
      Array.from({ length: Math.min(100, config.documents - offset) }, (_, n) => ({
        _id: String(offset + n).padStart(8, '0'),
        category: (offset + n) % 10,
        score: 0,
        payload,
      })),
    );
  }
  assert.equal(await db.records.countDocuments(), config.documents);
  // Warm connections and decoding before measured phases.
  await Promise.all(
    Array.from({ length: config.workers }, () => db.records.findOne({ _id: '00000000' })),
  );
  loop.enable();
  for (const phase of ['read', 'write', 'mixed']) {
    await scenario(`${phase} workload`, async () => {
      const started = performance.now();
      const deadline = started + (config.seconds * 1000) / 3;
      const metrics = new Map();
      await Promise.all(
        Array.from({ length: config.workers }, async (_, worker) => {
          let iteration = worker;
          while (performance.now() < deadline) {
            const id = String((iteration * 17 + worker) % config.documents).padStart(8, '0');
            const kind =
              phase === 'read'
                ? 'read'
                : phase === 'write'
                  ? 'update'
                  : ['read', 'read', 'update', 'bulk', 'aggregate'][iteration % 5];
            const start = performance.now();
            if (kind === 'read') {
              const row = await db.records.findOne(
                { _id: id },
                { projection: { score: 1, payload: 1, _id: 0 } },
              );
              assert(row && row.payload === payload && typeof row.score === 'number');
            } else if (kind === 'update') {
              const result = await db.records.updateOne({ _id: id }, { $inc: { score: 1 } });
              assert.equal(result.modifiedCount, 1);
              increments++;
            } else if (kind === 'bulk') {
              const result = await db.records.bulkWrite([
                { updateOne: { filter: { _id: id }, update: { $inc: { score: 1 } } } },
                { updateOne: { filter: { _id: id }, update: { $inc: { score: 1 } } } },
              ]);
              assert.equal(result.modifiedCount, 2);
              increments += 2;
            } else {
              const rows = await db.records
                .aggregate()
                .match({ category: iteration % 10 })
                .group({ _id: null, total: { $sum: '$score' }, count: { $sum: 1 } })
                .toArray();
              assert(rows[0]?.count > 0);
            }
            if (!metrics.has(kind)) metrics.set(kind, histogram());
            metrics.get(kind).add(performance.now() - start);
            iteration++;
          }
        }),
      );
      const elapsedMs = performance.now() - started;
      const operations = Object.fromEntries(
        [...metrics].map(([key, metric]) => [key, metric.result()]),
      );
      const count = Object.values(operations).reduce((sum, op) => sum + op.count, 0);
      const summary = {
        operations,
        elapsedMs,
        operationsPerSecond: Math.round((count * 1000) / elapsedMs),
        pool: pools(),
      };
      console.log(JSON.stringify({ phase, ...summary }));
      return summary;
    });
  }
  const totals = await db.records
    .aggregate()
    .group({ _id: null, total: { $sum: '$score' }, count: { $sum: 1 } })
    .toArray();
  assert.equal(totals[0].total, increments);
  assert.equal(totals[0].count, config.documents);
  report.acknowledgedIncrements = increments;

  await scenario('large-document reads and cursor cleanup', async () => {
    const largePayload = 'z'.repeat(256 * 1024);
    for (let offset = 0; offset < 128; offset += 8)
      await db.large.insertMany(
        Array.from({ length: 8 }, (_, n) => ({
          _id: String(offset + n).padStart(4, '0'),
          payload: largePayload,
        })),
      );
    const cursorCount = async () =>
      (await connection.db('admin').command({ serverStatus: 1 })).metrics.cursor.open.total;
    const initialCursors = await cursorCount();
    global.gc();
    const initialHeap = process.memoryUsage().heapUsed;
    // End each async frame before measuring retained memory; otherwise the last
    // find() result can remain live in the measuring function itself.
    async function scan(mode) {
      let count = 0;
      let maxHeap = process.memoryUsage().heapUsed;
      const inspect = (row) => {
        assert.equal(row.payload, largePayload);
        count++;
        maxHeap = Math.max(maxHeap, process.memoryUsage().heapUsed);
      };
      if (mode === 'find') {
        const rows = await db.large.find();
        for (const row of rows) inspect(row);
      } else if (mode === 'cursor') {
        for await (const row of db.large.cursor({}, { batchSize: 8 })) inspect(row);
      } else {
        for await (const batch of db.large.chunks({}, { size: 8 }))
          for (const row of batch) inspect(row);
      }
      assert.equal(count, 128);
      sample();
      return maxHeap;
    }
    const scans = [];
    for (let pass = 0; pass < 3; pass++) {
      for (const mode of ['find', 'cursor', 'chunks']) {
        global.gc();
        const beforeHeap = process.memoryUsage().heapUsed;
        const started = performance.now();
        const maxHeap = await scan(mode);
        const elapsedMs = Math.round(performance.now() - started);
        global.gc();
        scans.push({
          mode,
          pass,
          elapsedMs,
          beforeHeap,
          maxHeap,
          retainedHeap: process.memoryUsage().heapUsed,
        });
      }
    }
    for (let i = 0; i < 20; i++) {
      const cursor = db.large.cursor({}, { batchSize: 2 });
      for await (const row of cursor) {
        assert(row);
        break;
      }
      assert(cursor.closed);
      for await (const batch of db.large.chunks({}, { size: 2 })) {
        assert(batch.length);
        break;
      }
    }
    assert.equal(await cursorCount(), initialCursors, 'early exits must not leak server cursors');
    global.gc();
    const retainedGrowth = process.memoryUsage().heapUsed - initialHeap;
    assert(
      retainedGrowth < 64 * 1024 * 1024,
      'retained heap grew by more than 64 MiB after repeated scans',
    );
    return {
      documents: 128,
      payloadBytes: largePayload.length,
      scans,
      retainedGrowth,
      initialCursors,
    };
  });
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  throw error;
} finally {
  clearInterval(sampler);
  loop.disable();
  report.peakMemory = peak;
  report.eventLoop = {
    p95Ms: loop.percentile(95) / 1e6,
    p99Ms: loop.percentile(99) / 1e6,
    maxMs: loop.max / 1e6,
  };
  await db.close();
  report.poolAfterClose = pools();
  if (pools().open || pools().checkedOut) {
    report.passed = false;
    save();
    report.cleanupError = 'Client pools did not close';
    process.exitCode = 1;
  }
  save();
}
