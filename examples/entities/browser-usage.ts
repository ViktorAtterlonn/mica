import { collection, map, number, object, string, timestamps } from '@mica/db';

export const BrowserUsage = collection('browser_usage', {
  _id: string(),

  counts: map(number().integer().min(0)).default(() => ({})),

  sessions: map(
    object({
      browser: string(),
      visits: number().integer().min(0).default(0),
    }),
  ).default(() => ({})),

  ...timestamps(),
});

export type BrowserUsageRecord = typeof BrowserUsage.$inferSelect;
