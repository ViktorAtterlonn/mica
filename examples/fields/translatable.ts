import { customType, string } from '../../src/index.js';

export const translatable = customType({
  base: string,
  metadata: { translatable: true },
});
