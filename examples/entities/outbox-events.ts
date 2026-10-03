import { collection, date, enum_, index, objectId, string, timestamps } from '@mica/db';

export const OutboxEvents = collection(
  'outbox_events',
  {
    _id: objectId().auto(),

    topic: string(),
    state: enum_('pending', 'published').default('pending'),
    publishedAt: date().optional(),

    ...timestamps(),
  },
  (t) => [
    index('published_event_retention')
      .on(t.publishedAt)
      .expireAfterSeconds(7 * 24 * 60 * 60)
      .partial({ state: 'published' }),
  ],
);

// The application publishes events and sets publishedAt. MongoDB handles retention
// after this index is explicitly installed; the schema adds no publishing hooks.
export type OutboxEvent = typeof OutboxEvents.$inferSelect;
