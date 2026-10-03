import type { ObjectId } from 'mongodb';
import type { createExampleDatabase } from '../database.js';

export async function summarizeProducts(
  db: ReturnType<typeof createExampleDatabase>,
  organizationId: ObjectId,
) {
  return db.products
    .aggregate({ maxTimeMS: 5000 })
    .match({ organizationId })
    .group({
      _id: '$status',
      products: { $sum: 1 },
      totalCount: { $sum: '$details.count' },
    })
    .sort({ _id: 1 })
    .toArray();
  // Inferred: { _id: 'draft' | 'published' | 'archived'; products: number; totalCount: number }[]
}
