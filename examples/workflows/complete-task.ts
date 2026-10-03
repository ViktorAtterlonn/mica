import type { ObjectId } from 'mongodb';
import { createDatabase } from '@mica/db';
import { Tasks } from '../entities/tasks.js';
import { TaskEvents } from '../entities/task-events.js';

export function createTaskDatabase(uri: string, database: string) {
  return createDatabase({ uri, database, collections: { tasks: Tasks, events: TaskEvents } });
}

/** The caller authorizes the organization; this service applies the matching data filter. */
export async function completeTask(
  db: ReturnType<typeof createTaskDatabase>,
  organizationId: ObjectId,
  taskId: ObjectId,
): Promise<boolean> {
  return db.withTransaction(async (session) => {
    const task = await db.tasks.findOneAndUpdate(
      { _id: taskId, organizationId, state: 'open' },
      { $set: { state: 'done', completedAt: new Date() } },
      { session, returnDocument: 'after', projection: { _id: 1, organizationId: 1 } },
    );

    if (!task) return false;

    // The callback can run again. Record durable intent; deliver events after commit.
    await db.events.insertOne(
      {
        _id: `${task._id.toHexString()}:completed`,
        organizationId: task.organizationId,
        taskId: task._id,
        kind: 'task.completed',
      },
      { session },
    );

    return true;
  });
}
