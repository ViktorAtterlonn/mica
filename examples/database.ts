import { createDatabase } from '@mica/db';

import { Organizations } from './entities/organizations.js';
import { Products } from './entities/products.js';

interface ExampleDatabaseOptions {
  uri: string;
  database: string;
}

export function createExampleDatabase(options: ExampleDatabaseOptions) {
  return createDatabase({
    uri: options.uri,
    database: options.database,

    collections: {
      organizations: Organizations,
      products: Products,
    },

    events: {
      connected: (event) => console.log(event.status),
      disconnected: (event) => console.log(event.status),
      reconnected: (event) => console.log(event.status),
      error: (error) => console.error(error.message),
    },
  });
}
