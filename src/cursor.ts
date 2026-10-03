import type { Document, FindCursor } from 'mongodb';
import type { Fields } from './fields.js';
import type { Sort } from './query-types.js';
import { decodeDocument } from './codec.js';
import { pageNumber, prepareSort } from './query-options.js';

export interface TypedCursor<T, F extends Fields = Fields> extends AsyncIterable<T> {
  readonly closed: boolean;
  next(): Promise<T | null>;
  toArray(): Promise<T[]>;
  close(): Promise<void>;
  sort(sort: Sort<F>): this;
  skip(count: number): this;
  limit(count: number): this;
  batchSize(count: number): this;
}

/** The native cursor stays private so no consumption path can bypass decoding. */
export class DecodingCursor implements TypedCursor<Document> {
  private started = false;
  private finished = false;
  private consuming = false;

  constructor(
    private readonly native: FindCursor<Document>,
    private readonly fields: Fields,
    private readonly ready: () => void,
    private readonly signal?: AbortSignal,
  ) {}

  get closed(): boolean {
    return this.finished || this.native.closed;
  }

  private configurable() {
    if (this.started || this.closed) throw new Error('Cannot configure a started or closed cursor');
  }

  sort(sort: Sort<Fields>): this {
    this.configurable();
    this.native.sort(prepareSort(this.fields, sort));
    return this;
  }

  skip(count: number): this {
    this.configurable();
    this.native.skip(pageNumber(count, 'skip'));
    return this;
  }

  limit(count: number): this {
    this.configurable();
    this.native.limit(pageNumber(count, 'limit'));
    return this;
  }

  batchSize(count: number): this {
    this.configurable();
    this.native.batchSize(pageNumber(count, 'batchSize'));
    return this;
  }

  async close(): Promise<void> {
    this.finished = true;
    await this.native.close();
  }

  private async read(): Promise<Document | null> {
    this.started = true;
    try {
      this.signal?.throwIfAborted();
      if (this.closed) return null;
      this.ready();
      const value = await this.native.next();
      if (value === null) {
        await this.close();
        return null;
      }
      return decodeDocument(this.fields, value);
    } catch (error) {
      // Keep the query/codec error as the cause, even if cleanup also fails.
      await this.close().catch(() => {});
      throw error;
    }
  }

  private acquire() {
    if (this.consuming) throw new Error('Cursor already has an active consumer');
    this.consuming = true;
  }

  async next(): Promise<Document | null> {
    this.acquire();
    try {
      return await this.read();
    } finally {
      this.consuming = false;
    }
  }

  async toArray(): Promise<Document[]> {
    this.acquire();
    try {
      const result: Document[] = [];
      for (let value = await this.read(); value !== null; value = await this.read())
        result.push(value);
      return result;
    } finally {
      this.consuming = false;
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Document, void, void> {
    this.acquire();
    try {
      for (let value = await this.read(); value !== null; value = await this.read()) yield value;
    } finally {
      this.consuming = false;
      if (!this.closed) await this.close();
    }
  }
}
