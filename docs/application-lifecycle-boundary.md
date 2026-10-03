# Application lifecycle boundary

Mica describes and accesses persisted data. The application decides what to do with it.

Schemas, constraints, index declarations, timestamps, codecs, metadata, database operations, and connection lifecycle are persistence concerns. Publishing, archiving, soft deletion, anonymization, authorization, notifications, and event delivery are application concerns.

Use ordinary database operations inside explicit application services. The [task completion workflow](../examples/workflows/complete-task.ts) updates a task and records an outbox event in a transaction without adding hooks or model methods to the toolkit.

`translatable()` in the examples marks semantic metadata; it does not execute translations. `encrypted()` changes storage representation through an application-owned codec; it does not manage keys or access policy.
