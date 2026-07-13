# Desktop Releases

## Stable Release Process

1. Update the desktop, Cargo, Tauri config, and backend version to the intended
   `MAJOR.MINOR.PATCH` release version.
2. Run `RELEASE_TAG=vMAJOR.MINOR.PATCH pnpm release:check` and `pnpm gate`.
3. Create and push the matching `vMAJOR.MINOR.PATCH` tag.

The release workflow reruns the quality gate, validates those version values, and
builds a native Windows x64 installer. It publishes a GitHub Release only after the
build succeeds, with a `SHA256SUMS.txt` asset for manual verification. A Linux x64
cbranch server archive is built once, embedded into the installer for managed SSH
setup, and published as a separate release asset.

## Current Delivery Policy

Artifacts are manual downloads. They are not configured for the Tauri updater and
are not yet Authenticode-signed, macOS-notarized, or separately Linux-signed. Adding
automatic updates or platform signing requires managed credentials, signing policy,
and a key-rotation plan.
