import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { collection, createDatabase, number, string } from '../../dist/index.js';
import {
  client,
  direct,
  fault,
  members,
  poolMetrics,
  report,
  save,
  scenario,
  until,
} from './shared.mjs';

assert.equal(members.length, 3);
const Entries = collection('entries', { _id: string(), kind: string() });
const Counters = collection('counters', { _id: string(), count: number() });
const connection = client({ monitorCommands: true });
const pools = poolMetrics(connection);
const events = [];
const db = createDatabase({
  client: connection,
  database: 'mica_recovery',
  collections: { entries: Entries, counters: Counters },
  events: {
    connected: (event) => events.push(event),
    disconnected: (event) => events.push(event),
    reconnected: (event) => events.push(event),
  },
});
const primary = async () =>
  (await connection.db('admin').command({ hello: 1 })).primary.split(':')[0];
const healthy = () =>
  until(async () => {
    const status = await connection.db('admin').command({ replSetGetStatus: 1 });
    return (
      status.members.every((member) => [1, 2].includes(member.state)) && db.status === 'connected'
    );
  }, 'Replica set did not recover all three members');
let commits = 0;
let uncertainResponses = 0;
connection.on('commandStarted', (event) => {
  if (event.commandName === 'commitTransaction') commits++;
});
connection.on('commandSucceeded', (event) => {
  if (event.commandName === 'commitTransaction' && event.reply.writeConcernError)
    uncertainResponses++;
});

try {
  await db.connect();
  report.mongo = (await connection.db('admin').command({ buildInfo: 1 })).version;
  await db.counters.insertOne({ _id: 'transactions', count: 0 });
  await db.entries.insertOne({ _id: 'seed', kind: 'seed' });

  await scenario('primary process crash during majority writes', async () => {
    const oldPrimary = await primary();
    const acknowledged = [];
    const failed = [];
    let trigger;
    const ready = new Promise((resolve) => {
      trigger = resolve;
    });
    const writes = Promise.all(
      Array.from({ length: 4 }, async (_, worker) => {
        for (let i = 0; i < 80; i++) {
          const id = `crash-${worker}-${i}`;
          try {
            await db.entries.insertOne({ _id: id, kind: 'crash' }, { timeoutMS: 5000 });
            acknowledged.push(id);
            if (acknowledged.length === 20) trigger();
          } catch (error) {
            failed.push({ id, name: error.name, message: error.message });
          }
          await delay(20);
        }
      }),
    );
    await Promise.race([
      ready,
      writes.then(() => {
        throw new Error('Workload ended before the crash trigger');
      }),
    ]);
    const start = performance.now();
    await fault('kill', oldPrimary);
    const newPrimary = await until(async () => {
      const host = await primary();
      return host !== oldPrimary && db.status === 'connected' && host;
    }, 'No replacement primary elected');
    const failoverMs = Math.round(performance.now() - start);
    await writes;
    await db.entries.insertOne({ _id: 'after-crash', kind: 'probe' });
    for (const id of acknowledged)
      assert(await db.entries.exists({ _id: id }), `Acknowledged write lost: ${id}`);
    const total = await db.entries.countDocuments({ kind: 'crash' });
    assert(total >= acknowledged.length && total <= acknowledged.length + failed.length);
    assert(acknowledged.length > 20, 'writes must resume after failover');
    await fault('start', oldPrimary);
    await healthy();
    const former = await direct(oldPrimary);
    try {
      await until(
        async () =>
          (await former
            .db('mica_recovery')
            .collection('entries')
            .countDocuments({ kind: 'crash' }, { readPreference: 'secondaryPreferred' })) === total,
        'Former primary did not catch up',
      );
    } finally {
      await former.close();
    }
    return {
      failoverMs,
      acknowledged: acknowledged.length,
      failed,
      stored: total,
      uncertainWritesPresent: total - acknowledged.length,
      newPrimary: members.indexOf(newPrimary),
    };
  });

  await scenario('election during a transaction retries atomically', async () => {
    let attempts = 0;
    const before = (await db.counters.findOne({ _id: 'transactions' })).count;
    await db.withTransaction(
      async (session) => {
        attempts++;
        await db.entries.insertOne(
          { _id: 'transaction-election', kind: 'transaction' },
          { session },
        );
        if (attempts === 1) {
          const admin = await direct(await primary());
          try {
            await admin.db('admin').command({ replSetStepDown: 10, force: true });
          } finally {
            await admin.close();
          }
        }
        await db.counters.updateOne({ _id: 'transactions' }, { $inc: { count: 1 } }, { session });
      },
      { timeoutMS: 30_000, writeConcern: { w: 'majority' } },
    );
    assert(attempts >= 2, 'the transaction callback must actually retry');
    assert.equal(await db.entries.countDocuments({ _id: 'transaction-election' }), 1);
    assert.equal((await db.counters.findOne({ _id: 'transactions' })).count, before + 1);
    await healthy();
    return { attempts, committedEffects: 1 };
  });

  await scenario('uncertain commit retries commit without rerunning callback', async () => {
    const admin = await direct(await primary());
    const initialCommits = commits;
    const initialUncertain = uncertainResponses;
    let attempts = 0;
    const before = (await db.counters.findOne({ _id: 'transactions' })).count;
    try {
      await admin.db('admin').command({
        configureFailPoint: 'failCommand',
        mode: { times: 1 },
        data: {
          appName: 'mica-stress',
          failCommands: ['commitTransaction'],
          writeConcernError: { code: 64, errmsg: 'synthetic uncertain commit' },
          errorLabels: ['UnknownTransactionCommitResult'],
        },
      });
      await db.withTransaction(
        async (session) => {
          attempts++;
          await db.entries.insertOne(
            { _id: 'transaction-uncertain', kind: 'transaction' },
            { session },
          );
          await db.counters.updateOne({ _id: 'transactions' }, { $inc: { count: 1 } }, { session });
        },
        { timeoutMS: 30_000, writeConcern: { w: 'majority' } },
      );
    } finally {
      await admin.db('admin').command({ configureFailPoint: 'failCommand', mode: 'off' });
      await admin.close();
    }
    assert.equal(attempts, 1);
    assert(commits - initialCommits >= 2);
    assert.equal(uncertainResponses - initialUncertain, 1);
    assert.equal(await db.entries.countDocuments({ _id: 'transaction-uncertain' }), 1);
    assert.equal((await db.counters.findOne({ _id: 'transactions' })).count, before + 1);
    return {
      callbackAttempts: attempts,
      commitCommands: commits - initialCommits,
      uncertainResponses: uncertainResponses - initialUncertain,
      committedEffects: 1,
    };
  });

  await scenario('pool exhaustion bounds queued reads and releases connections', async () => {
    const smallClient = client({
      appName: 'mica-stress-pool',
      maxPoolSize: 1,
      waitQueueTimeoutMS: 100,
    });
    const smallPools = poolMetrics(smallClient);
    const smallDb = createDatabase({
      client: smallClient,
      database: 'mica_recovery',
      collections: { entries: Entries },
    });
    const admin = await direct(await primary());
    let blocked;
    try {
      await smallDb.connect();
      const configured = await admin.db('admin').command({
        configureFailPoint: 'failCommand',
        mode: { times: 1 },
        data: {
          appName: 'mica-stress-pool',
          failCommands: ['find'],
          blockConnection: true,
          blockTimeMS: 800,
        },
      });
      blocked = smallDb.entries.findOne({ _id: 'seed' });
      await admin.db('admin').command({
        waitForFailPoint: 'failCommand',
        timesEntered: configured.count + 1,
        maxTimeMS: 3000,
      });
      const queued = await Promise.allSettled(
        Array.from({ length: 8 }, () => smallDb.entries.findOne({ _id: 'seed' })),
      );
      assert(
        queued.every(
          (result) =>
            result.status === 'rejected' && result.reason.name === 'MongoWaitQueueTimeoutError',
        ),
      );
      assert(await blocked);
      assert(await smallDb.entries.findOne({ _id: 'seed' }));
      return { queueTimeouts: queued.length, recovered: true };
    } finally {
      await admin.db('admin').command({ configureFailPoint: 'failCommand', mode: 'off' });
      await blocked?.catch(() => {});
      await smallDb.close();
      await admin.close();
      assert.equal(smallPools().open, 0);
      assert.equal(smallPools().checkedOut, 0);
    }
  });

  await scenario('majority loss bounds operations and recovers', async () => {
    const current = await primary();
    const stopped = members.filter((member) => member !== current);
    for (const member of stopped) await fault('kill', member);
    const timedWrite = async (id, write) => {
      const start = performance.now();
      let failure;
      try {
        await write();
      } catch (error) {
        failure = { name: error.name, message: error.message };
      }
      assert(failure, 'a write without a majority must not be acknowledged');
      return { id, elapsedMs: Math.round(performance.now() - start), failure };
    };
    const id = 'uncertain-majority-write';
    const measurements = await Promise.all([
      timedWrite(id, () =>
        db.entries.insertOne({ _id: id, kind: 'uncertain' }, { timeoutMS: 1500 }),
      ),
      timedWrite('native-majority-write', () =>
        connection
          .db('mica_recovery')
          .collection('entries')
          .insertOne({ _id: 'native-majority-write', kind: 'uncertain' }, { timeoutMS: 1500 }),
      ),
      timedWrite('cancelled-majority-write', () =>
        db.entries.insertOne(
          { _id: 'cancelled-majority-write', kind: 'uncertain' },
          { timeoutMS: 1500, signal: AbortSignal.timeout(1500) },
        ),
      ),
    ]);
    console.log('Majority-loss deadlines', measurements);
    // Driver 7.7.0 can reselect a retry server without carrying the CSOT context.
    // Preserve this native limitation as evidence, rather than hiding it with a Promise.race.
    for (const measurement of measurements)
      assert(measurement.elapsedMs < 12_000, JSON.stringify(measurement));
    assert(
      measurements[2].elapsedMs < 4000,
      'cancellation must bound the operation even during retry selection',
    );
    for (const member of stopped) await fault('start', member);
    await healthy();
    await db.entries.insertOne({ _id: 'after-majority-recovery', kind: 'probe' });
    // A timeout is not evidence of rollback; inspect the outcome instead of blindly retrying.
    const uncertainWritePresent = await db.entries.exists({ _id: 'uncertain-majority-write' });
    return {
      timeoutMS: 1500,
      serverSelectionTimeoutMS: 8000,
      measurements,
      uncertainWritePresent,
      recovered: true,
    };
  });
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  throw error;
} finally {
  await db.close();
  report.events = events;
  report.poolAfterClose = pools();
  if (pools().open || pools().checkedOut) {
    report.passed = false;
    save();
    report.cleanupError = 'Client pools did not close';
    process.exitCode = 1;
  }
  save();
}
