import { ObjectId } from 'mongodb';

import { discoverMetadata, jsonSchema } from '@mica/db';
import { createExampleDatabase } from './database.js';
import { Products, type NewProduct } from './entities/products.js';

// This is an executable isolated example, not an application migration.
const uri = process.env.MICA_EXAMPLE_URI;

if (!uri) {
  throw new Error('Set MICA_EXAMPLE_URI to your local test MongoDB');
}

const database = `mica_example_${Date.now()}`;
const db = createExampleDatabase({ uri, database });

try {
  await db.connect();

  await db.client.db(database).createCollection(Products.$name, {
    validator: jsonSchema(Products),
  });

  const input: NewProduct = {
    organizationId: new ObjectId(),
    title: 'Example',

    details: { label: 'Nested' },
    variants: [],

    secrets: [],
    internalNotes: 'private',
  };

  const { insertedId } = await db.products.insertOne(input);

  await db.products.updateOne(
    { _id: insertedId },
    {
      $set: { internalNotes: 'updated' },
      $push: { secrets: 'another secret' },
    },
  );

  const projected = await db.products.findOne(
    { _id: insertedId },
    { projection: { title: 1, internalNotes: 1, _id: 0 } },
  );

  console.log(projected); // { title: 'Example', internalNotes: 'updated' }
  console.log(discoverMetadata(Products, 'translatable'));
} finally {
  try {
    if (db.status === 'connected') {
      await db.client.db(database).dropDatabase();
    }
  } finally {
    await db.close();
  }
}
