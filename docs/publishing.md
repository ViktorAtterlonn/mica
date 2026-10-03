# Publishing the repository

## GitHub setup

Create the repository with `main` as its default branch and add the chosen remote locally. This checkout intentionally has no preconfigured owner or repository URL.

Before opening it to contributors:

- Enable private vulnerability reporting in the repository Security settings.
- Require pull requests and the CI checks for merges to `main`.
- Set the repository description and topics.
- Review repository visibility and maintainer access.

Run `pnpm run check` before the first push. Review `git status --short` and the actual files being committed. Generated output, dependencies, local archives, logs, and environment files are ignored. Synthetic examples are sufficient for reproductions; do not add private application models or data.

## npm is a separate release

The workspace root always remains `private: true`. Both `@mica/db` and `@mica/cli` also retain `private: true` until an explicitly reviewed npm release. The package names have been selected; access to the `@mica` scope has not been verified.

Before release, verify scope ownership, select compatible versions, remove `private` from the two package manifests, and establish an explicit release review. Publish the database package before the CLI. Both manifests specify public access for the scoped packages.

Pack through pnpm so workspace references become ordinary version ranges:

```sh
pnpm --filter @mica/db pack
pnpm --filter @mica/cli pack
pnpm test:package
```

Pack hooks build the packages and copy LICENSE and NOTICE from the repository root. The database tarball contains no CLI or TypeScript loader. The CLI declares a compatible database peer dependency. The package smoke test installs the tarballs outside the workspace; it does not publish them.
