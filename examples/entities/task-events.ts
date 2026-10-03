import { collection, date, enum_, objectId, string } from '@mica/db';

export const TaskEvents = collection('task_events', {
  _id: string().immutable(),
  organizationId: objectId().immutable(),
  taskId: objectId().immutable(),
  kind: enum_('task.completed').immutable(),
  createdAt: date()
    .default(() => new Date())
    .immutable(),
});
