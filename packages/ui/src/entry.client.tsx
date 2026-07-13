// Client entry (React Router 8 framework mode). RR would synthesize a default entry, but we
// provide our own to keep rendering under `<StrictMode>`. The no-flash theme application
// (NF-THEME-6) is owned by the blocking inline `THEME_SCRIPT` in `root.tsx`'s <head>, which
// runs before first paint — earlier than this deferred bundle ever could — so there is no
// `applyStoredTheme()` call here. Runtime theme changes still flow through the store (`setTheme`
// → `applyTheme`); `applyStoredTheme` remains for tests and any non-prerendered entry path.

import { startTransition, StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { HydratedRouter } from 'react-router/dom';

// // React Grab maps copied UI elements back to source files. Vite removes this dynamic
// // import from production builds, so the inspector is available only under `pnpm dev`.
// if (import.meta.env.DEV) void import('react-grab');

startTransition(() => {
    hydrateRoot(
        document,
        <StrictMode>
            <HydratedRouter />
        </StrictMode>,
    );
});
