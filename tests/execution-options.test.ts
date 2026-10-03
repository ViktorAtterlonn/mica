import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MicaValidationError } from '../packages/db/src/index.js';
import { prepareQueryOptions } from '../packages/db/src/query-options.js';

test('execution budgets validate and abort signals keep their identity and reason', () => {
  const controller = new AbortController();
  assert.deepEqual(
    prepareQueryOptions({ timeoutMS: 0, maxTimeMS: 10, signal: controller.signal }),
    {
      timeoutMS: 0,
      maxTimeMS: 10,
      signal: controller.signal,
    },
  );
  for (const key of ['timeoutMS', 'maxTimeMS'])
    for (const value of [-1, NaN, Infinity, 0.5, '100', Number.MAX_SAFE_INTEGER + 1])
      assert.throws(
        () => prepareQueryOptions({ [key]: value }),
        (error) => error instanceof MicaValidationError && error.path === key,
      );
  assert.throws(() => prepareQueryOptions({ signal: {} }), MicaValidationError);
  const reason = new Error('cancelled');
  controller.abort(reason);
  assert.throws(
    () => prepareQueryOptions({ signal: controller.signal }),
    (error) => error === reason,
  );
});
