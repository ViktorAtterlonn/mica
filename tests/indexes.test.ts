import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Binary, ObjectId } from 'mongodb';

import {
  array,
  collection,
  customType,
  date,
  enum_,
  index,
  number,
  object,
  objectId,
  string,
  type IndexField,
} from '../packages/db/src/index.js';

const fields = {
  _id: objectId().auto(),
  owner: objectId(),
  status: enum_('draft', 'published'),
  createdAt: date(),
  details: object({ slug: string() }).optional(),
  tags: array(object({ label: string() })),
};

test('index declarations preserve directions, nested multikey paths and immutable builder branching', () => {
  const schema = collection('indexed', fields, (t) => {
    const base = index('recent').on(t.owner, t.createdAt.desc());
    const unique = base.unique();
    assert.notEqual(base, unique);
    return [
      base,
      index('slug').on(t['details.slug'].asc()).unique().sparse(),
      index('tags').on(t['tags.label']),
    ];
  });
  assert.deepEqual(schema.$indexes, [
    { name: 'recent', key: { owner: 1, createdAt: -1 } },
    { name: 'slug', key: { 'details.slug': 1 }, unique: true, sparse: true },
    { name: 'tags', key: { 'tags.label': 1 } },
  ]);
  assert.deepEqual(collection('no_indexes', fields).$indexes, []);
});

test('partial filters are snapshotted and exported specs cannot mutate schema declarations', () => {
  const owner = new ObjectId();
  const start = new Date('2026-01-01');
  const filter = {
    owner,
    createdAt: { $gte: start },
    $or: [{ status: 'published' as const }, { 'details.slug': { $exists: true as const } }],
  };
  const schema = collection('partial', fields, (t) => [
    index('active').on(t.owner).unique().partial(filter),
  ]);
  start.setFullYear(2030);
  filter.$or.length = 0;
  const specs = schema.$indexes;
  specs[0]!.partialFilterExpression!.createdAt.$gte.setFullYear(2040);
  specs[0]!.name = 'mutated';
  specs.length = 0;
  assert.equal(schema.$indexes[0]!.name, 'active');
  assert.equal(schema.$indexes[0]!.partialFilterExpression!.createdAt.$gte.getFullYear(), 2026);
  assert.equal(schema.$indexes[0]!.partialFilterExpression!.$or.length, 2);
  assert(schema.$indexes[0]!.partialFilterExpression!.owner.equals(owner));
});

test('index definitions describe stored values without running codecs', () => {
  const secret = customType({
    base: string,
    codec: {
      encode(): Binary {
        throw Error('must not encode index definitions');
      },
      decode(): string {
        throw Error('must not decode index definitions');
      },
      storedSchema: { bsonType: 'binData' },
    },
  });
  const bytes = new Binary(Buffer.from('stored'));
  const schema = collection('codec_index', { _id: objectId(), secret: secret() }, (t) => [
    index('stored')
      .on(t.secret)
      .partial({ secret: { $eq: bytes } }),
  ]);
  assert(schema.$indexes[0]!.partialFilterExpression!.secret.$eq instanceof Binary);
  assert.deepEqual(schema.$indexes[0]!.partialFilterExpression!.secret.$eq.value(), bytes.value());
});

test('invalid keys, foreign references and conflicting declarations fail at definition time', () => {
  for (const name of ['', ' ', 'bad\0name', '_id_']) assert.throws(() => index(name), /name/i);
  assert.throws(() => (index('empty').on as () => unknown)(), /at least one/);
  assert.throws(
    () => collection('bad', fields, (t) => [index('repeat').on(t.owner, t.owner.desc())]),
    /repeat/,
  );
  assert.throws(
    () => collection('bad', fields, (t) => [index('same').on(t.owner), index('same').on(t.status)]),
    /Duplicate/,
  );
  assert.throws(() => collection('bad', fields, (t) => [index('id').on(t._id)]), /MongoDB owns/);
  assert.throws(
    () => collection('bad', fields, () => [index('raw').on('owner' as never)]),
    /references/,
  );
  assert.throws(() => collection('bad', fields, () => [index('unfinished') as never]), /Expected/);
  let foreign!: IndexField<unknown>;
  collection('first', fields, (t) => {
    foreign = t.owner;
    return [];
  });
  assert.throws(
    () => collection('second', fields, () => [index('foreign').on(foreign)]),
    /another collection/,
  );
  assert.throws(
    () => collection('second', fields, (t) => [index('mixed').on(foreign, t.owner)]),
    /same collection/,
  );
  assert.throws(
    () => collection('bad', { ...fields, $indexes: string() }),
    /Invalid field|Reserved/,
  );
  assert.throws(
    () =>
      collection('bad', fields, (t) => [
        index('both').on(t.owner).sparse().partial({ status: 'draft' }),
      ]),
    /both sparse and partial/,
  );
  assert.throws(
    () =>
      collection('bad', fields, (t) => [
        index('both').on(t.owner).partial({ status: 'draft' }).sparse(),
      ]),
    /both sparse and partial/,
  );
});

test('runtime partial validation rejects unsupported paths, operators and invalid BSON literals', () => {
  for (const filter of [
    {},
    { missing: 1 },
    { $nor: [{ status: 'draft' }] },
    { $and: [] },
    { $or: [{ missing: true }] },
    { status: { $ne: 'draft' } },
    { status: { $exists: false } },
    { status: { $type: 'unknown' } },
    { status: { $in: [] } },
    { status: { $eq: undefined } },
    { status: /draft/ },
    { status: { $eq: () => 1 } },
  ]) {
    assert.throws(() =>
      collection('bad', fields, (t) => [
        index('bad')
          .on(t.owner)
          .partial(filter as never),
      ]),
    );
  }
});

test('integer-looking key names retain compound order through a native Map', () => {
  const schema = collection(
    'numeric_names',
    { _id: objectId(), '1': string(), '2': string() },
    (t) => [index('ordered').on(t['2'], t['1'])],
  );
  assert(schema.$indexes[0]!.key instanceof Map);
  assert.deepEqual([...schema.$indexes[0]!.key.keys()], ['2', '1']);
});

test('runtime index paths obey the same bounded traversal as type-level paths', () => {
  const schema = collection(
    'depth',
    {
      _id: objectId(),
      a: object({ b: object({ c: object({ d: object({ e: object({ f: number() }) }) }) }) }),
      rows: array(array(object({ a: object({ b: object({ c: number() }) }) }))),
    },
    (t) => {
      assert('a.b.c.d.e' in t);
      assert(!('a.b.c.d.e.f' in t));
      assert('rows.a.b' in t);
      assert(!('rows.a.b.c' in t));
      return [index('deep').on(t['a.b.c.d.e']), index('array_depth').on(t['rows.a.b'])];
    },
  );
  assert.equal(schema.$indexes.length, 2);
});

test('TTL declarations preserve zero, modifier chains, and immutable branching', () => {
  const schema = collection(
    'ttl',
    {
      ...fields,
      expiresAt: date().optional().nullable(),
      dates: array(date()),
      nested: array(object({ when: date() })),
    },
    (t) => {
      const base = index('expires').on(t.expiresAt.desc());
      const ttl = base.expireAfterSeconds(0);
      assert.notEqual(base, ttl);
      const ordinary = collection('ordinary', fields, (other) => [
        index('recent').on(other.createdAt),
      ]);
      assert(!Object.hasOwn(ordinary.$indexes[0]!, 'expireAfterSeconds'));
      return [
        ttl.partial({ status: 'published' }),
        index('dates').on(t.dates).sparse().expireAfterSeconds(60),
        index('nested').on(t['nested.when']).expireAfterSeconds(2_147_483_647).unique(),
      ];
    },
  );
  assert.deepEqual(schema.$indexes, [
    {
      name: 'expires',
      key: { expiresAt: -1 },
      expireAfterSeconds: 0,
      partialFilterExpression: { status: 'published' },
    },
    { name: 'dates', key: { dates: 1 }, expireAfterSeconds: 60, sparse: true },
    { name: 'nested', key: { 'nested.when': 1 }, expireAfterSeconds: 2_147_483_647, unique: true },
  ]);
  schema.$indexes[0]!.expireAfterSeconds = 999;
  assert.equal(schema.$indexes[0]!.expireAfterSeconds, 0);
});

test('TTL rejects invalid durations and ineligible fields even when types are bypassed', () => {
  const dateCodec = customType({
    base: date,
    codec: {
      encode: (value: Date) => value,
      decode: (value: Date) => value,
      storedSchema: { bsonType: 'date' },
    },
  });
  const ttlFields = {
    ...fields,
    secret: dateCodec(),
    dates: array(date()),
    matrix: array(array(date())),
  };
  for (const seconds of [-1, 0.5, NaN, Infinity, 2_147_483_648, '60', undefined]) {
    assert.throws(
      () =>
        collection('invalid_ttl', ttlFields, (t) => [
          index('expires')
            .on(t.createdAt)
            .expireAfterSeconds(seconds as number),
        ]),
      /integer from 0 to 2147483647/,
    );
  }
  collection('invalid_ttl_fields', ttlFields, (t) => {
    for (const definition of [
      index('string').on(t.status),
      index('compound').on(t.createdAt, t.owner),
      index('codec').on(t.secret),
      index('matrix').on(t.matrix),
      index('object').on(t.details),
    ])
      assert.throws(
        () => Reflect.apply(definition.expireAfterSeconds, definition, [60]),
        /single date field or date array/,
      );
    assert.throws(() => index('id').on(t._id), /MongoDB owns/);
    return [];
  });
});
