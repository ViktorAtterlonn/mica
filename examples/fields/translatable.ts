import { customType, string } from '@mica/db';

export const translatable = customType({
  base: string,
  metadata: { translatable: true },
});
