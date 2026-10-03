import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';
import { jsonSchema } from '../packages/db/src/index.js';
import { Tasks } from '../examples/entities/tasks.js';
import { TaskEvents } from '../examples/entities/task-events.js';
import { completeTask, createTaskDatabase } from '../examples/workflows/complete-task.js';

const uri = process.env.MICA_TEST_URI;
if (!uri) throw new Error('Use pnpm run test:integration for isolated MongoDB');

test('task completion commits once and rolls back when its outbox write fails', async (t) => {
  const db = createTaskDatabase(uri, 'mica_workflow');
  t.after(() => db.close());
  await db.connect();
  for (const schema of [Tasks, TaskEvents]) {
    const raw = await db.client
      .db('mica_workflow')
      .createCollection(schema.$name, { validator: jsonSchema(schema) });
    if (schema.$indexes.length) await raw.createIndexes(schema.$indexes);
  }
  const organizationId = new ObjectId();
  const { insertedId } = await db.tasks.insertOne({
    organizationId,
    title: 'Ship a sample',
    internalNote: 'private',
  });
  assert.equal(await completeTask(db, new ObjectId(), insertedId), false);
  const results = await Promise.all(
    Array.from({ length: 8 }, () => completeTask(db, organizationId, insertedId)),
  );
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await completeTask(db, organizationId, insertedId), false);
  assert.equal(await db.events.countDocuments(), 1);
  const task = await db.tasks.findOne({ _id: insertedId });
  assert.equal(task?.state, 'done');
  assert(task?.completedAt instanceof Date);
  assert.equal(task?.internalNote, 'private');

  const pending = await db.tasks.insertOne({ organizationId, title: 'Roll back a failed event' });
  await db.events.insertOne({
    _id: `${pending.insertedId.toHexString()}:completed`,
    organizationId,
    taskId: pending.insertedId,
    kind: 'task.completed',
  });
  await assert.rejects(completeTask(db, organizationId, pending.insertedId), { code: 11000 });
  const unchanged = await db.tasks.findOne({ _id: pending.insertedId });
  assert.equal(unchanged?.state, 'open');
  assert.equal(unchanged?.completedAt, undefined);
  const exported = [];
  for await (const batch of db.tasks.chunks(
    { organizationId, state: 'done' },
    {
      size: 1,
      projection: { title: 1, _id: 0 },
    },
  ))
    exported.push(...batch);
  assert.deepEqual(exported, [{ title: 'Ship a sample' }]);
});
