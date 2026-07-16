# Hello World Plugin

This is the smallest cbranch trusted ESM plugin. Its single command returns the
provided input and current repository id; it requests no cbranch capabilities.

```sh
pnpm --filter @cbranch/plugin-hello-world build
pnpm --filter @cbranch/plugin-hello-world package
```

The package command writes
`artifacts/dev.cbranch.hello-world.cbranch-plugin`. It contains only the
validated `plugin.json` manifest and compiled `plugin.mjs` entrypoint.

The plugin is a test artifact, not an installed plugin by itself. Installing it
requires a catalog entry whose publisher fingerprint, artifact digest, length,
and capability digest match this archive, followed by explicit publisher trust
and enablement. It runs with the host user's authority once enabled.
