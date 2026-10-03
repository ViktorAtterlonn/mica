import { collection, objectId, string } from '@mica/db';

export const Organizations = collection('organizations', {
  _id: objectId().auto(),

  name: string(),
});

export type Organization = typeof Organizations.$inferSelect;
export type NewOrganization = typeof Organizations.$inferInsert;
