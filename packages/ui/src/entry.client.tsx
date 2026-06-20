// Client entry (React Router 8 framework mode). RR would synthesize a default entry, but
// we provide our own to apply the persisted theme BEFORE hydration — keeping the
// no-flash-of-wrong-theme guarantee (NF-THEME-6) that the old `main.tsx` had — and to keep
// rendering under `<StrictMode>`.

import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

import { applyStoredTheme } from "./theme/theme";

// Toggle the root `.dark` class from the stored preference before the first paint.
applyStoredTheme();

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  );
});
