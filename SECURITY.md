# Security policy

## Reporting

Do not post vulnerability details, credentials, or sensitive reproductions in a public issue. Use GitHub's private vulnerability reporting option on the repository's Security tab when available. If it has not been enabled, ask a maintainer for a private reporting channel without disclosing the vulnerability itself.

Include the affected commit or version, a minimal reproduction using synthetic data, the expected behavior, and the impact. There is currently no response-time guarantee or bug bounty program.

## Supported versions

Mica is in early development. Security fixes currently target the latest default-branch code; there are no supported historical release lines yet.

## Boundaries

Mica is not an authorization layer. Applications must authorize callers and supply appropriate tenant/resource filters. Projection defaults and immutable field checks do not restrict raw driver access. Install generated validators explicitly when relying on server-side stored-value constraints.

Custom codecs are application code. Applications own key storage, rotation, access controls, and the handling of decoded values. Example cryptography is for demonstrating the codec boundary, not a key-management system.

Cancelled or timed-out writes may have committed. Use appropriate transactions and application idempotency for workflows that need stronger guarantees.
