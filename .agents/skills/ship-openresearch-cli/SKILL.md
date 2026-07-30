---
name: ship-openresearch-cli
description: Required shipping gate for the openresearch-cli repository. Invoke whenever committing, pushing, shipping, opening or updating a PR, preparing a PR, or completing ship-change in openresearch-cli. Runs the repository’s exact Rust formatting, clippy, locked-test, and PR checks.
---

# Ship openresearch-cli

Run the current `.github/workflows/ci.yml` gate after the final edit:

```sh
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo build --locked
cargo test --locked
```

Run in CI order because the Cargo commands share the target directory and build locks. A later edit invalidates the relevant results.

If `Cargo.toml` changes the package version:

- Confirm it increases from the PR base using semantic-version ordering.
- Confirm `Cargo.lock` contains the same package version.
- Confirm the corresponding `v<version>` tag does not already exist.
- Call out that merging the version bump triggers a release.

Keep the PR summary concise and preserve unverified manual checks as unchecked items.
