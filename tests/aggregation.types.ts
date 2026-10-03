// Compiled by tsc; these functions do not connect to a database.
import { Binary, ObjectId } from 'mongodb';
import {
  array,
  collection,
  createDatabase,
  customType,
  map,
  number,
  object,
  objectId,
  string,
} from '../packages/db/src/index.js';

const encrypted = customType({
  base: string,
  codec: {
    encode: (value: string) => new Binary(Buffer.from(value)),
    decode: (value: Binary) => value.toString(),
    storedSchema: { bsonType: 'binData' },
  },
});
const Records = collection('aggregate_types', {
  _id: objectId().auto(),
  category: string(),
  amount: number().optional().nullable(),
  secret: encrypted(),
  profile: object({ label: string(), count: number(), hidden: string() }).optional().nullable(),
  rows: array(object({ label: string(), price: number(), secret: encrypted() })),
  counts: map(number()),
});
const db = createDatabase({
  uri: 'mongodb://127.0.0.1:1',
  database: 'unused',
  collections: { records: Records },
});
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expect<T extends true>() {}

async function inference() {
  const base = db.records.aggregate();
  const full = (await base.toArray())[0]!;
  full._id satisfies ObjectId;
  full.secret satisfies string;
  full.rows[0]!.secret satisfies string;
  const projected = base.project({ category: 1, secret: 1, _id: 0 });
  const selected = (await projected.toArray())[0]!;
  expect<Equal<typeof selected.secret, string>>();
  // @ts-expect-error projection removes _id
  selected._id;
  // @ts-expect-error projection removes paths from later filters
  projected.match({ amount: 1 });
  // @ts-expect-error projection removes paths from later sorts
  projected.sort({ amount: 1 });
  // @ts-expect-error projection removes paths from later projections
  projected.project({ amount: 1 });
  // @ts-expect-error group cannot refer to removed input fields
  projected.group({ _id: '$amount' });
  const nested = (
    await base.project({ 'profile.label': 1, 'rows.label': 1, _id: 0 }).toArray()
  )[0]!;
  nested.profile?.label satisfies string | undefined;
  // @ts-expect-error nested field excluded
  nested.profile?.count;
  // @ts-expect-error array child excluded
  nested.rows[0]!.price;
  const hidden = (await base.project({ rows: 1 }).toArray())[0]!;
  hidden.rows[0]!.secret satisfies string;
  const excluded = (await base.project({ category: 0 }).toArray())[0]!;
  excluded.secret satisfies string;
  excluded.rows[0]!.secret satisfies string;
  const grouped = base.group({
    _id: '$category',
    total: { $sum: '$amount' },
    count: { $sum: 1 },
    average: { $avg: '$amount' },
    min: { $min: '$amount' },
    max: { $max: '$amount' },
  });
  const row = (
    await grouped
      .match({ total: { $gt: 0 } })
      .sort({ total: -1 })
      .toArray()
  )[0]!;
  expect<Equal<typeof row._id, string>>();
  expect<Equal<typeof row.total, number>>();
  expect<Equal<typeof row.average, number | null>>();
  // @ts-expect-error original field no longer present
  grouped.match({ category: 'x' });
  // @ts-expect-error string field cannot be summed
  base.group({ _id: null, total: { $sum: '$category' } });
  // @ts-expect-error numeric field still has numeric filter operands after grouping
  grouped.match({ total: 'wrong' });
  // @ts-expect-error codec-backed group key
  base.group({ _id: '$secret' });
  // @ts-expect-error array traversal would change scalar group semantics
  base.group({ _id: '$rows.label' });
  // @ts-expect-error whole objects are not supported group keys
  base.group({ _id: '$profile' });
  // @ts-expect-error non-accumulator output
  base.group({ _id: null, total: '$amount' });
  // @ts-expect-error accumulator must have one operator
  base.group({ _id: null, total: { $sum: 1, $avg: '$amount' } });
  // @ts-expect-error unsupported accumulator
  base.group({ _id: null, values: { $push: '$category' } });
  // @ts-expect-error output names cannot contain dots
  base.group({ _id: null, 'bad.name': { $sum: 1 } });
  const nullableKey = (await base.group({ _id: '$profile.label' }).toArray())[0]!;
  expect<Equal<typeof nullableKey._id, string | null>>();
  const optionalKey = (await base.group({ _id: '$amount' }).toArray())[0]!;
  expect<Equal<typeof optionalKey._id, number | null>>();
  const all = (await base.group({ _id: null, total: { $sum: 1 } }).toArray())[0]!;
  expect<Equal<typeof all._id, null>>();
  const counted = base.count('total');
  const count = (await counted.toArray())[0]!;
  expect<Equal<typeof count.total, number>>();
  // @ts-expect-error count doesn't preserve _id
  count._id;
  // @ts-expect-error count doesn't preserve input fields
  counted.match({ category: 'x' });
  // @ts-expect-error output alias must be a single literal
  base.count('total' as string);
  // @ts-expect-error union aliases cannot promise both fields
  base.count('total' as 'total' | 'count');
  // @ts-expect-error map-entry projections are deferred
  base.project({ 'counts.one': 1 });
  // @ts-expect-error mixed projection
  base.project({ category: 1, amount: 0 });
  // @ts-expect-error dynamic projection values cannot infer an exact shape
  base.project({ category: 1 as 0 | 1 });
  // @ts-expect-error no raw pipeline overload that pretends to infer arbitrary stages
  db.records.aggregate([{ $out: 'other' }]);
}
void inference;

const References = collection('aggregate_references', {
  _id: objectId().auto(),
  owner: objectId(),
  ids: array(objectId()),
  profile: object({ owner: objectId(), label: string() }),
  rows: array(object({ owner: objectId() })),
  links: map(objectId()),
});
const referenceDb = createDatabase({
  uri: 'mongodb://127.0.0.1:1',
  database: 'unused',
  collections: { references: References },
});

async function objectIdMatchInference(id: string) {
  const base = referenceDb.references.aggregate();
  const matched = base.match({
    _id: id,
    owner: { $in: [id, new ObjectId()] },
    ids: { $all: [id], $elemMatch: { $eq: id } },
    profile: { owner: id, label: id },
    rows: { $elemMatch: { owner: id } },
    'links.owner': id,
    $or: [{ owner: { $not: { $eq: id } } }, { 'profile.owner': id }],
  });
  base.match({ ids: [id], rows: [{ owner: id }], links: { owner: id } });
  base.match({ ids: id });
  const value = (await matched.project({ _id: 1, owner: 1 }).toArray())[0]!;
  expect<Equal<typeof value._id, ObjectId>>();
  expect<Equal<typeof value.owner, ObjectId>>();
  base.project({ owner: 1 }).match({ owner: id });
  const grouped = base.group({ _id: '$owner', total: { $sum: 1 } }).match({ _id: id });
  const group = (await grouped.toArray())[0]!;
  expect<Equal<typeof group._id, ObjectId>>();
  // @ts-expect-error MongoDB reserves _id as a count alias
  base.count('_id');
  const numericKey = base.group({ _id: null, total: { $sum: 1 } }).group({ _id: '$total' });
  // @ts-expect-error a numeric group key remains numeric even when named _id
  numericKey.match({ _id: id });
  // @ts-expect-error numeric accumulator output does not accept strings
  grouped.match({ total: id });
  // @ts-expect-error accepting an ID string must not enable regex operators on ObjectIds
  base.match({ _id: { $regex: 'abc' } });
  // @ts-expect-error accepting an ID string must not enable literal regex on ObjectIds
  base.match({ _id: /abc/ });
  // @ts-expect-error string schema fields don't accept ObjectIds
  base.match({ 'profile.label': new ObjectId() });
  // @ts-expect-error ordinary find retains its existing strict ObjectId input contract
  referenceDb.references.find({ _id: id });
}
void objectIdMatchInference;
