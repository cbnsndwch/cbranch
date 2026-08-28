# cbranch system atlas

An isolated, source-backed visualization of the cbranch runtime. The map is
pinned to the reviewed `be09896` source snapshot; every inspector claim links to
that revision. Animated packets are representative DTO, schema, or test-fixture
examples and are never presented as live telemetry.

From the repository root, launch it with:

```bash
pnpm dev:system-map
```

Vite opens `http://127.0.0.1:5174/`. Use the left outline or map buildings to
select a subsystem, double-click a building (or choose **Explore internals**) to
drill in, and use **Resume flow**, **Trace one step**, and **Reset view** to
inspect the three source-derived request paths.

Focused checks:

```bash
pnpm --filter @cbranch/system-map build
pnpm --filter @cbranch/system-map verify:sources
pnpm vitest run apps/system-map/src
```
