import { Binary } from 'mongodb';
import {
  array,
  collection,
  createDatabase,
  customType,
  enum_,
  index,
  map,
  number,
  object,
  objectId,
  string,
  timestamps,
  type Filter,
} from '../src/index.js';

const encoded = customType({
  base: string,
  codec: {
    storedSchema: { bsonType: 'binData' },
    encode: (value: string) => new Binary(Buffer.from(value)),
    decode: (value: Binary) => Buffer.from(value.value()).toString(),
  },
});
const Records = collection(
  'filter_complexity',
  {
    _id: objectId().auto(),
    title: string(),
    extra: string().optional(),
    status: enum_('draft', 'published').default('draft'),
    score: number().default(0),
    fixed: string().immutable(),
    secret: encoded().select(false),
    profile: object({ label: string(), count: number() }).nullable().optional(),
    nested: object({
      leaf: object({ leaf: string(), label: string(), secret: encoded() }),
      label: string(),
      secret: encoded(),
    }),
    rows: array(object({ label: string(), score: number(), secret: encoded() })),
    counts: map(number()),
    ...timestamps(),
  },
  (t) => [index('status_score').on(t.status, t.score.desc())],
);

const db = createDatabase({
  uri: 'mongodb://127.0.0.1:1',
  database: 'unused',
  collections: { records: Records },
});
const filter: Filter<typeof Records.$fields> = {
  status: 'published',
  'rows.score': { $gte: 1 },
};

// This pretyped filter previously exhausted the compiler's instantiation budget.
async function projectedQuery() {
  const rows = await db.records.find(filter, {
    projection: { title: 1, secret: 1, 'profile.label': 1, 'rows.label': 1, _id: 0 },
  });
  rows[0]!.secret satisfies string;
  // @ts-expect-error projection retains its exact output
  rows[0]!._id;
}
void projectedQuery;

const nested: Filter<typeof Records.$fields> = {
  $and: [{ $or: [filter, { $nor: [{ score: { $lt: 0 } }] }] }],
};
db.records.find(nested);
// @ts-expect-error recursive logical branches still validate operands
db.records.find({ $and: [{ $or: [{ $nor: [{ score: 'wrong' }] }] }] });
