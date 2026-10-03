import { MicaValidationError } from './errors.js';
import { Binary, ObjectId } from 'mongodb';

export type Kind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'objectId'
  | 'binary'
  | 'object'
  | 'array'
  | 'map'
  | 'custom';

export type JsonSchema = Record<string, unknown>;

export interface Definition {
  readonly kind: Kind;
  readonly validate?: (value: unknown) => boolean;
  readonly storedSchema?: JsonSchema;
  readonly optional?: boolean;
  readonly immutable?: boolean;
  readonly nullable?: boolean;
  readonly defaultValue?: () => unknown;
  readonly generated?: 'id' | 'createdAt' | 'updatedAt';
  readonly min?: number;
  readonly max?: number;
  readonly pattern?: RegExp;
  readonly integer?: boolean;
  readonly values?: readonly string[];
  readonly fields?: Fields;
  readonly element?: AnyField;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly reference?: () => AnyField;
  readonly codec?: {
    encode(value: unknown): unknown;
    decode(value: unknown): unknown;
    storedSchema: JsonSchema;
  };
}

export interface FieldTypes {
  app: unknown;
  stored: unknown;
  insert: unknown;
  kind: Kind;
  optional: boolean;
  immutable: boolean;
  codec: boolean;
  defaulted: boolean;
  generated: boolean;
  children: unknown;
  element: unknown;
}

export interface AnyField {
  readonly definition: Definition;
  readonly $types: FieldTypes;
}

export type Fields = Record<string, AnyField>;

export type Mode = 'app' | 'stored' | 'insert' | 'select';

type FieldValue<F extends AnyField, M extends Mode> = F['$types'][M extends 'select' ? 'app' : M];

type OptionalKey<F extends AnyField, M extends Mode> = F['$types']['optional'] extends true
  ? true
  : M extends 'insert'
    ? F['$types']['defaulted'] extends true
      ? true
      : F['$types']['generated']
    : false;

export type InferFields<F extends Fields, M extends Mode> = {
  -readonly [K in keyof F as OptionalKey<F[K], M> extends true ? never : K]: FieldValue<F[K], M>;
} & {
  -readonly [K in keyof F as OptionalKey<F[K], M> extends true ? K : never]?: FieldValue<F[K], M>;
};

/** Immutable builder. Phantom parameters describe values, never hydrated documents. */
export class Field<
  A,
  S = A,
  I = A,
  K extends Kind = Kind,
  O extends boolean = false,
  D extends boolean = false,
  G extends boolean = false,
  C = unknown,
  E = unknown,
  IM extends boolean = false,
  X extends boolean = false,
> implements AnyField {
  declare readonly $types: {
    app: A;
    stored: S;
    insert: I;
    kind: K;
    optional: O;
    immutable: IM;
    codec: X;
    defaulted: D;
    generated: G;
    children: C;
    element: E;
  };

  readonly definition: Definition;

  constructor(definition: Definition) {
    this.definition = Object.freeze({ ...definition });
  }

  immutable(): Field<A, S, I, K, O, D, G, C, E, true, X> {
    return new Field({ ...this.definition, immutable: true });
  }

  optional(): Field<A, S, I, K, true, D, G, C, E, IM, X> {
    return new Field({ ...this.definition, optional: true });
  }

  nullable(): Field<A | null, S | null, I | null, K, O, D, G, C, E, IM, X> {
    return new Field({ ...this.definition, nullable: true });
  }

  default(value: I | (() => I)): Field<A, S, I, K, O, true, G, C, E, IM, X> {
    return new Field({
      ...this.definition,
      defaultValue: typeof value === 'function' ? (value as () => I) : () => value,
    });
  }

  min(
    this: K extends 'string' | 'number' | 'array' ? Field<A, S, I, K, O, D, G, C, E, IM, X> : never,
    value: number,
  ): Field<A, S, I, K, O, D, G, C, E, IM, X> {
    if (!Number.isFinite(value)) {
      throw new Error('min must be finite');
    }
    if (
      ['string', 'array'].includes(this.definition.kind) &&
      (!Number.isSafeInteger(value) || value < 0)
    ) {
      throw new Error('min length requires a nonnegative safe integer');
    }

    return new Field({ ...this.definition, min: value });
  }

  max(
    this: K extends 'string' | 'number' | 'array' ? Field<A, S, I, K, O, D, G, C, E, IM, X> : never,
    value: number,
  ): Field<A, S, I, K, O, D, G, C, E, IM, X> {
    if (!Number.isFinite(value)) {
      throw new Error('max must be finite');
    }
    if (
      ['string', 'array'].includes(this.definition.kind) &&
      (!Number.isSafeInteger(value) || value < 0)
    ) {
      throw new Error('max length requires a nonnegative safe integer');
    }

    return new Field({ ...this.definition, max: value });
  }

  pattern(
    this: K extends 'string' ? Field<A, S, I, K, O, D, G, C, E, IM, X> : never,
    value: RegExp,
  ): Field<A, S, I, K, O, D, G, C, E, IM, X> {
    if (value.flags) {
      throw new Error('Phase 0 patterns must have no flags');
    }

    return new Field({ ...this.definition, pattern: value });
  }

  integer(
    this: K extends 'number' ? Field<A, S, I, K, O, D, G, C, E, IM, X> : never,
  ): Field<A, S, I, K, O, D, G, C, E, IM, X> {
    return new Field({ ...this.definition, integer: true });
  }

  auto(
    this: K extends 'objectId' ? Field<A, S, I, K, O, D, G, C, E, IM, X> : never,
  ): Field<A, S, I, K, O, D, true, C, E, IM, X> {
    return new Field({ ...this.definition, generated: 'id' });
  }

  references(target: () => AnyField): Field<A, S, I, K, O, D, G, C, E, IM, X> {
    return new Field({ ...this.definition, reference: target });
  }
}

export const string = () => new Field<string, string, string, 'string'>({ kind: 'string' });

export const number = () => new Field<number, number, number, 'number'>({ kind: 'number' });

export const boolean = () => new Field<boolean, boolean, boolean, 'boolean'>({ kind: 'boolean' });

export const date = () => new Field<Date, Date, Date, 'date'>({ kind: 'date' });

export const objectId = () =>
  new Field<ObjectId, ObjectId, ObjectId, 'objectId'>({ kind: 'objectId' });

export const binary = () => new Field<Binary, Binary, Binary, 'binary'>({ kind: 'binary' });

export function enum_<const V extends readonly [string, ...string[]]>(...values: V) {
  return new Field<V[number], V[number], V[number], 'string'>({
    kind: 'string',
    values: Object.freeze([...values]),
  });
}

export type ObjectField<F extends Fields> = Field<
  InferFields<F, 'app'>,
  InferFields<F, 'stored'>,
  InferFields<F, 'insert'>,
  'object',
  false,
  false,
  false,
  F
>;

export function object<const F extends Fields>(fields: F): ObjectField<F> {
  checkFields(fields);

  return new Field({ kind: 'object', fields: Object.freeze({ ...fields }) });
}

export function array<F extends AnyField>(element: F) {
  if (element.definition.optional) {
    throw new Error('Array elements cannot be optional');
  }

  return new Field<
    F['$types']['app'][],
    F['$types']['stored'][],
    F['$types']['insert'][],
    'array',
    false,
    false,
    false,
    unknown,
    F
  >({ kind: 'array', element });
}

/** Dynamic entries are atomic paths; values retain their full schema and codecs. */
export function map<F extends AnyField>(value: F) {
  if (value.definition.optional)
    throw new Error('Map values cannot be optional; keys may be omitted');
  return new Field<
    Record<string, F['$types']['app']>,
    Record<string, F['$types']['stored']>,
    Record<string, F['$types']['insert']>,
    'map',
    false,
    false,
    false,
    unknown,
    F
  >({ kind: 'map', element: value });
}

export const mapKeyPattern = '^(?!__proto__$|constructor$|prototype$)[^$.\\x00][^.\\x00]*$';
export function checkMapKey(key: string, path = key): void {
  if (!new RegExp(mapKeyPattern).test(key))
    throw new MicaValidationError('invalid_map_key', path, `Invalid map key: ${key}`);
}

export function timestamps() {
  return {
    createdAt: new Field<Date, Date, Date, 'date', false, false, true>({
      kind: 'date',
      generated: 'createdAt',
    }),
    updatedAt: new Field<Date, Date, Date, 'date', false, false, true>({
      kind: 'date',
      generated: 'updatedAt',
    }),
  };
}

type CustomField<B extends AnyField, S, X extends boolean = B['$types']['codec']> = Field<
  B['$types']['app'],
  S,
  B['$types']['insert'],
  B['$types']['kind'],
  B['$types']['optional'],
  B['$types']['defaulted'],
  B['$types']['generated'],
  B['$types']['children'],
  B['$types']['element'],
  B['$types']['immutable'],
  X
>;

export interface CustomValueOptions<A> {
  validate(value: unknown): value is A;
  storedSchema: JsonSchema;
  metadata?: Readonly<Record<string, unknown>>;
}

/** A complete custom value is an atomic query/update leaf, even when it contains objects. */
export function customType<A>(options: CustomValueOptions<A>): () => Field<A, A, A, 'custom'>;

export function customType<B extends AnyField>(options: {
  base: () => B;
  metadata: Readonly<Record<string, unknown>>;
}): () => CustomField<B, B['$types']['stored']>;

export function customType<B extends AnyField, S>(options: {
  base: () => B;
  metadata?: Readonly<Record<string, unknown>>;
  codec: {
    encode(value: B['$types']['app']): S;
    decode(value: S): B['$types']['app'];
    storedSchema: JsonSchema;
  };
}): () => CustomField<B, S | Extract<B['$types']['app'], null>, true>;

export function customType(
  options:
    | CustomValueOptions<unknown>
    | {
        base: () => AnyField;
        metadata?: Readonly<Record<string, unknown>>;
        codec?: {
          encode: (value: never) => unknown;
          decode: (value: never) => unknown;
          storedSchema: JsonSchema;
        };
      },
): () => AnyField {
  if ('validate' in options) {
    return () =>
      new Field({
        kind: 'custom',
        validate: options.validate,
        storedSchema: options.storedSchema,
        ...(options.metadata ? { metadata: Object.freeze({ ...options.metadata }) } : {}),
      });
  }

  return () => {
    const base = options.base();

    if (options.codec && (base.definition.fields || base.definition.element)) {
      throw new Error(
        'Composite codecs are deferred; compose codecs inside object/array fields instead',
      );
    }

    if (base.definition.codec && options.codec) {
      throw new Error('Stacked codecs are not supported in Phase 0');
    }

    return new Field({
      ...base.definition,
      ...(options.metadata
        ? { metadata: Object.freeze({ ...base.definition.metadata, ...options.metadata }) }
        : {}),
      ...(options.codec ? { codec: options.codec as Definition['codec'] & {} } : {}),
    });
  };
}

export function checkFields(fields: Fields) {
  for (const key of Object.keys(fields)) {
    if (
      !key ||
      key.includes('.') ||
      key.includes('\0') ||
      key.startsWith('$') ||
      ['__proto__', 'constructor', 'prototype'].includes(key)
    ) {
      throw new Error(`Invalid field name: ${key}`);
    }
  }
}
