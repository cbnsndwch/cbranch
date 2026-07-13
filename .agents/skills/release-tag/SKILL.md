---
name: release-tag
description: Use when the user asks to create a cbranch release tag, bump the desktop version, publish a release, or generate release notes.
---

# Release Tag

Prepare and publish a cbranch desktop release. Stable releases are published by
`.github/workflows/release.yml` after all Windows, macOS, and Ubuntu bundles pass.

## Rules

- Never create or push a tag, commit, or release without explicit user approval.
- Never call `gh release create` for a stable cbranch release. The tag workflow
  creates the release only after every platform artifact succeeds.
- Use annotated tags named `vMAJOR.MINOR.PATCH`.
- Do not enable Tauri updater publishing, platform code signing, or notarization
  unless the user explicitly provides the associated credentials and policy.

## 1. Determine The Version

1. Read the current desktop version from `apps/tauri/package.json` and the latest
   `v*` tag.
2. Default to a patch bump unless the user requests major or minor.
3. State the proposed version and wait for approval before editing files.

## 2. Draft Release Notes

1. Collect non-merge commits since the previous stable tag.
2. Categorize conventional commits:
   - `feat` -> Features
   - `fix` -> Bug fixes
   - `refactor` -> Refactors
   - `build`, `chore`, `ci`, `docs`, `perf`, `style`, `test` -> Maintenance
3. Attribute each entry to its GitHub author when available:
   - Resolve PR authors with `gh pr view`.
   - Otherwise query the commit author through `gh api`.
   - Fall back to the Git author name.
4. Show the complete notes in a Markdown code block and wait for approval.

## 3. Update Version Sources

Set the approved `MAJOR.MINOR.PATCH` value consistently in:

- `apps/tauri/package.json`
- `apps/tauri/src-tauri/tauri.conf.json`
- `apps/tauri/src-tauri/Cargo.toml`
- `apps/tauri/src-tauri/Cargo.lock` for the `cbranch-desktop` package
- `packages/rpc-contract/src/schemas/system.ts` (`CBRANCH_BACKEND_VERSION`)

Prepend the approved notes as a `## vMAJOR.MINOR.PATCH` section in
`CHANGELOG.md`. The release workflow extracts that exact section for GitHub.

Then verify from the repository root:

```sh
RELEASE_TAG=vMAJOR.MINOR.PATCH pnpm release:check
node scripts/extract-release-notes.mjs vMAJOR.MINOR.PATCH
pnpm gate
```

Commit the approved version and release notes using:

```text
chore(release): prepare vMAJOR.MINOR.PATCH
```

## 4. Tag And Publish

After the user approves the commit and tag:

```sh
git tag -a vMAJOR.MINOR.PATCH -m "vMAJOR.MINOR.PATCH"
git push origin <branch>
git push origin vMAJOR.MINOR.PATCH
```

Watch the `Release desktop clients` workflow. It must produce Windows x64 NSIS,
macOS Apple Silicon DMG, macOS Intel DMG, Ubuntu DEB, Ubuntu AppImage, and
`SHA256SUMS.txt`. Report the GitHub Release URL after the workflow succeeds.
