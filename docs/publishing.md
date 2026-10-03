# Publishing the repository

## GitHub setup

Create the repository with `main` as its default branch and add the chosen remote locally. This checkout intentionally has no preconfigured owner or repository URL.

Before opening it to contributors:

- Enable private vulnerability reporting in the repository Security settings.
- Require pull requests and the CI checks for merges to `main`.
- Set the repository description and topics.
- Review repository visibility and maintainer access.

Run `npm run check` before the first push. Review `git status --short` and the actual files being committed. Generated output, dependencies, local archives, logs, and environment files are ignored. Synthetic examples are sufficient for reproductions; do not add private application models or data.

## npm is a separate release

The package retains `private: true` to prevent accidental npm publication. Public GitHub source and an npm release are separate decisions. The local name `mica-mongodb` has not been reserved or checked for availability.

Before an npm release, choose and verify the package name, add the actual GitHub repository/homepage/bugs URLs to the manifest, select a version, remove `private`, and establish a release workflow with an explicit review step. Inspect the tarball with `npm pack --dry-run`. Apache-2.0 license and notice files are included in the package.
