import {
  array,
  collection,
  index,
  enum_,
  number,
  object,
  objectId,
  string,
  timestamps,
} from '@mica/db';

import { encrypted } from '../fields/encrypted.js';
import { translatable } from '../fields/translatable.js';
import { Organizations } from './organizations.js';

export const Products = collection(
  'products',
  {
    _id: objectId().auto(),

    organizationId: objectId().references(() => Organizations._id),

    title: translatable().min(1).max(200),
    status: enum_('draft', 'published', 'archived').default('draft'),
    description: string().nullable().optional(),

    details: object({
      label: translatable(),
      secret: encrypted().max(500).optional(),
      count: number().default(0),
    }),

    variants: array(
      object({
        sku: string(),
        title: translatable().max(200),
        price: number().min(0),
        secret: encrypted().optional(),
      }),
    ),

    secrets: array(encrypted()),
    internalNotes: encrypted().max(5_000).optional(),

    ...timestamps(),
  },
  (t) => [
    index('organization_idx').on(t.organizationId),
    index('organization_status_idx').on(t.organizationId, t.status),
    index('recent_products_idx').on(t.organizationId, t.createdAt.desc()),
  ],
);

export type Product = typeof Products.$inferSelect;
export type NewProduct = typeof Products.$inferInsert;
export type StoredProduct = typeof Products.$inferStored;
export type ProductUpdate = typeof Products.$inferUpdate;
