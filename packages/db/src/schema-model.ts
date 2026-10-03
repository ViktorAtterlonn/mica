/** JSON-safe schema metadata, independent of declarations, driver responses, and rendering. */
export type SchemaValue =
  | null
  | boolean
  | number
  | string
  | SchemaValue[]
  | { [key: string]: SchemaValue };
export type SchemaObject = { [key: string]: SchemaValue };

export interface SchemaIssue {
  scope: 'collection' | 'validator' | 'index';
  code: string;
  path: string[];
  /** Extended JSON preserves unsupported configuration for inspection. */
  source: string;
}

export type PartialPredicate =
  | { kind: 'and' | 'or'; terms: PartialPredicate[] }
  | { kind: 'condition'; path: string; operator: string; value: string };

export interface NormalizedValidator {
  schema: SchemaObject | null;
  level: string;
  action: string;
}

export interface NormalizedIndex {
  name: string;
  keys: [string, 1 | -1][];
  unique: boolean;
  sparse: boolean;
  partial: PartialPredicate | null;
  expireAfterSeconds: number | null;
  issues: SchemaIssue[];
}

export interface NormalizedCollection {
  name: string;
  exists: boolean;
  validator: NormalizedValidator;
  indexes: NormalizedIndex[];
  issues: SchemaIssue[];
}

export interface DatabaseSchema {
  collections: NormalizedCollection[];
}

export interface ValueDifference {
  path: string[];
  before?: SchemaValue;
  after?: SchemaValue;
}

type ChangeBase = {
  collection: string;
  risks: ('existing-data' | 'index-rebuild' | 'index-drop' | 'ttl-deletion')[];
};
export type SchemaChange = ChangeBase &
  (
    | { kind: 'collection-added'; after: NormalizedCollection }
    | {
        kind: 'validator-added' | 'validator-removed' | 'validator-changed';
        before: NormalizedValidator;
        after: NormalizedValidator;
        details: ValueDifference[];
      }
    | { kind: 'index-added'; after: NormalizedIndex }
    | { kind: 'index-removed'; before: NormalizedIndex }
    | { kind: 'index-changed'; before: NormalizedIndex; after: NormalizedIndex }
    | { kind: 'unsupported'; side: 'desired' | 'actual'; issue: SchemaIssue }
  );

export interface SchemaDiff {
  version: 1;
  desired: DatabaseSchema;
  actual: DatabaseSchema;
  changes: SchemaChange[];
  unmanagedIndexes: { collection: string; index: NormalizedIndex }[];
}

/** Locale-independent ordering keeps reports stable across machines. */
export const compareNames = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
