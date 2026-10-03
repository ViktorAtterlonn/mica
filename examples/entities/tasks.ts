import { collection, date, enum_, index, objectId, string, timestamps } from '../../src/index.js';

export const Tasks = collection(
  'tasks',
  {
    _id: objectId().auto(),
    organizationId: objectId().immutable(),
    title: string().min(1),
    state: enum_('open', 'done').default('open'),
    completedAt: date().optional(),
    internalNote: string().optional().select(false),
    ...timestamps(),
  },
  (t) => [index('organization_state').on(t.organizationId, t.state)],
);

export type Task = typeof Tasks.$inferSelect;
export type NewTask = typeof Tasks.$inferInsert;
