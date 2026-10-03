# ADR 023 — Operation deadlines and cancellation

Read/write options now accept `timeoutMS`, `maxTimeMS`, and `signal`. Insert and batch options accept them too; a batch has one set of execution options, not separate options on individual entries. Durations must be nonnegative safe integers. Zero disables the corresponding limit. Mica passes these options to the installed MongoDB driver, preserving its timeout errors and the signal's cancellation reason.

`timeoutMS` is the driver's client-side budget; `maxTimeMS` is a server processing limit. With client-side timeout enabled, the driver controls the effective server limit. These are operation budgets, not a deadline for application code or an entire transaction. For cursors, native cursor lifetime timeout semantics apply. For `chunks`, each page is a separate operation with a fresh budget; one shared signal can cancel the entire traversal, including between pages.

An already-aborted signal rejects before a driver call. Cursor cancellation closes the cursor, and chunk cancellation stops before the next page. In-flight cancellation is delegated to the driver. An interrupted write can already have committed; cancellation does not imply rollback. The driver may close an in-flight connection on timeout/abort.

Integration tests use failpoints enabled only in the disposable test container to delay reads/writes, verify real client timeouts and cancellation, and check lazy traversal cleanup. No production server parameters are changed.
