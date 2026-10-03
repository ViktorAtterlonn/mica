import { collection, objectId, string } from '../../src/index.js';

export const Organizations = collection('organizations', {
  _id: objectId().auto(),

  name: string(),
});

export type Organization = typeof Organizations.$inferSelect;
export type NewOrganization = typeof Organizations.$inferInsert;
