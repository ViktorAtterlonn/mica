import {
  MongoClient,
  type ClientSession,
  type ClientSessionOptions,
  type TransactionOptions,
  type TopologyDescriptionChangedEvent,
} from 'mongodb';
import type { CollectionSchema } from './schema.js';
import { bindCollection, type TypedCollection } from './collection.js';
export type { TypedCollection } from './collection.js';

export type DatabaseStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'closing'
  | 'closed';

export interface LifecycleEvent {
  readonly status: DatabaseStatus;
  readonly reason: 'connect' | 'topology' | 'close';
}

export interface DatabaseEvents {
  connected?(event: LifecycleEvent): void;
  disconnected?(event: LifecycleEvent): void;
  reconnected?(event: LifecycleEvent): void;
  error?(error: Error): void;
}

export type DatabaseOptions<C extends Record<string, CollectionSchema>> = {
  database: string;
  collections: C;
  events?: DatabaseEvents;
} & ({ uri: string; client?: never } | { client: MongoClient; uri?: never });

export interface DatabaseLifecycle {
  readonly client: MongoClient;
  readonly status: DatabaseStatus;
  connect(): Promise<void>;
  close(): Promise<void>;
  startSession(options?: ClientSessionOptions): ClientSession;
  withTransaction<T>(
    work: (session: ClientSession) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
}

export type Database<C extends Record<string, CollectionSchema>> = DatabaseLifecycle & {
  readonly [K in keyof C]: TypedCollection<C[K]['$fields']>;
};

class Connection implements DatabaseLifecycle {
  readonly client: MongoClient;
  private current: DatabaseStatus = 'idle';
  private connectedBefore = false;
  private connecting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private probing = false;
  private topologyVersion = 0;
  private writable = false;

  constructor(
    private readonly database: string,
    client: MongoClient,
    private readonly events: DatabaseEvents,
  ) {
    this.client = client;
    client.on('topologyDescriptionChanged', this.onTopology);
    client.on('topologyClosed', this.onTopologyClosed);
  }

  startSession(options?: ClientSessionOptions): ClientSession {
    this.assertReady();
    return this.client.startSession(options);
  }

  assertReady(): void {
    // Topology loss is temporary: let driver selection, deadlines and transaction
    // retry labels govern operations after the first successful connection.
    if (!this.connectedBefore || this.current === 'closing' || this.current === 'closed') {
      throw new Error(
        'Call db.connect() before operations; database is not connected or is closed',
      );
    }
  }

  async withTransaction<T>(
    work: (session: ClientSession) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    const session = this.startSession();
    try {
      return await session.withTransaction(() => work(session), options);
    } finally {
      await session.endSession();
    }
  }

  get status(): DatabaseStatus {
    return this.current;
  }

  private report(error: unknown) {
    try {
      this.events.error?.(error instanceof Error ? error : new Error(String(error)));
    } catch {
      /* User error callbacks cannot break lifecycle cleanup. */
    }
  }

  private emit(
    name: 'connected' | 'disconnected' | 'reconnected',
    reason: LifecycleEvent['reason'],
  ) {
    try {
      this.events[name]?.({ status: this.current, reason });
    } catch (error) {
      this.report(error);
    }
  }

  private onTopologyClosed = () => {
    this.writable = false;
    this.topologyVersion++;

    if (this.current === 'connected') {
      this.current = 'disconnected';
      this.emit('disconnected', 'topology');
    }
  };

  private onTopology = (event: TopologyDescriptionChangedEvent) => {
    this.topologyVersion++;
    const description = event.newDescription;
    this.writable =
      description.type === 'LoadBalanced' ||
      [...description.servers.values()].some((server) =>
        ['RSPrimary', 'Standalone', 'Mongos', 'LoadBalancer'].includes(server.type),
      );

    if (!this.writable && this.current === 'connected') {
      this.current = 'disconnected';
      this.emit('disconnected', 'topology');
    }

    if (this.writable && this.current === 'disconnected' && this.connectedBefore) {
      void this.probe();
    }
  };

  private async probe() {
    if (this.probing) {
      return;
    }

    this.probing = true;
    const version = this.topologyVersion;

    try {
      await this.client.db(this.database).command({ ping: 1 }, { readPreference: 'primary' });

      if (this.current === 'disconnected' && this.writable && version === this.topologyVersion) {
        this.current = 'connected';
        this.emit('reconnected', 'topology');
      }
    } catch (error) {
      this.report(error);
    } finally {
      this.probing = false;
    }

    if (version !== this.topologyVersion && this.current === 'disconnected' && this.writable) {
      void this.probe();
    }
  }

  connect(): Promise<void> {
    if (this.current === 'closing' || this.current === 'closed') {
      return Promise.reject(new Error('Database is closing or closed'));
    }

    if (this.connecting) {
      return this.connecting;
    }

    if (this.current === 'connected') {
      return Promise.resolve();
    }

    this.current = 'connecting';
    this.connecting = (async () => {
      try {
        await this.client.connect();
        await this.client.db(this.database).command({ ping: 1 }, { readPreference: 'primary' });

        if (this.current === 'closing') {
          return;
        }

        this.current = 'connected';
        const event = this.connectedBefore ? 'reconnected' : 'connected';
        this.connectedBefore = true;
        this.emit(event, 'connect');
      } catch (error) {
        if (this.current !== 'closing') {
          this.current = 'disconnected';
        }

        this.report(error);
        throw error;
      } finally {
        this.connecting = undefined;
      }
    })();

    return this.connecting;
  }

  close(): Promise<void> {
    if (this.closing) {
      return this.closing;
    }

    if (this.current === 'closed') {
      return Promise.resolve();
    }

    const wasConnected = this.current === 'connected';
    this.current = 'closing';
    this.closing = (async () => {
      try {
        await this.connecting?.catch(() => {});
        await this.client.close();
        this.current = 'closed';

        if (wasConnected) {
          this.emit('disconnected', 'close');
        }
      } catch (error) {
        this.current = 'disconnected';
        this.report(error);
        throw error;
      } finally {
        if (this.current === 'closed') {
          this.client.off('topologyDescriptionChanged', this.onTopology);
          this.client.off('topologyClosed', this.onTopologyClosed);
        }

        this.closing = undefined;
      }
    })();

    return this.closing;
  }
}

export function createDatabase<const C extends Record<string, CollectionSchema>>(
  options: DatabaseOptions<C>,
): Database<C> {
  const hasUri = 'uri' in options;
  const hasClient = 'client' in options;

  if (hasUri === hasClient) {
    throw new Error('Supply exactly one of uri or client');
  }

  const reserved = new Set([
    'client',
    'status',
    'connect',
    'close',
    'startSession',
    'withTransaction',
    '__proto__',
    'prototype',
    'constructor',
  ]);

  for (const key of Object.keys(options.collections)) {
    if (reserved.has(key)) {
      throw new Error(`Reserved database collection key: ${key}`);
    }
  }

  const connection = new Connection(
    options.database,
    options.client ?? new MongoClient(options.uri!),
    options.events ?? {},
  );
  const database: DatabaseLifecycle = {
    client: connection.client,
    get status() {
      return connection.status;
    },
    connect: () => connection.connect(),
    close: () => connection.close(),
    startSession: (options) => connection.startSession(options),
    withTransaction: (work, options) => connection.withTransaction(work, options),
  };

  for (const [key, schema] of Object.entries(options.collections)) {
    Object.defineProperty(database, key, {
      value: bindCollection(
        connection.client.db(options.database).collection(schema.$name),
        schema,
        () => connection.assertReady(),
      ),
      enumerable: true,
    });
  }

  return Object.freeze(database) as Database<C>;
}
