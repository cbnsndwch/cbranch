// Framework-mode root route (React Router 8, SPA). This module replaces the old
// `index.html` + `main.tsx` pair:
//   • `Layout` is the HTML document shell RR renders the app into. Because `ssr: false`,
//     it is rendered once at build time into the static `index.html` and then hydrated.
//   • the default export is the root component: it wires the app-wide providers (the RPC
//     runtime + React Query) around the routed `<Outlet />`, and bridges URL → store.
//
// ConnectionProvider creates one runtime and React Query client for each selected
// endpoint. It disposes both before replacing a profile, so server data never leaks
// between browser or desktop connections.

import { useEffect, useState } from 'react';
import {
    isRouteErrorResponse,
    Links,
    Meta,
    Outlet,
    Scripts,
    ScrollRestoration,
} from 'react-router';

import type { Route } from './+types/root';
import { ConnectionFailureScreen } from './components/ConnectionFailureScreen';
import { ConnectionProfilesScreen } from './desktop/ConnectionProfilesScreen';
import { isDesktopSurface } from './desktop/bridge';
import { ConnectionProvider, useConnection } from './rpc/connection-provider';
import { defaultHostEndpoint } from './rpc/client';
import { SyncRouteToStore } from './state/SyncRouteToStore';

import appStyles from './styles.css?url';
import diffStyles from 'react-diff-view/style/index.css?url';

// Stylesheets are linked (not side-effect imported) so RR can inject them into the
// document `<head>` via `<Links />` and code-split them per route in the future.
export const links: Route.LinksFunction = () => [
    { rel: 'stylesheet', href: diffStyles },
    { rel: 'stylesheet', href: appStyles },

    // Favicon / PWA icon pack (realfavicongenerator) — lives in `public/`, served at the root.
    {
        rel: 'icon',
        type: 'image/png',
        href: '/favicon-96x96.png',
        sizes: '96x96',
    },
    { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
    { rel: 'shortcut icon', href: '/favicon.ico' },
    {
        rel: 'apple-touch-icon',
        href: '/apple-touch-icon.png',
        sizes: '180x180',
    },
    { rel: 'manifest', href: '/site.webmanifest' },
];

// Blocking inline script that applies the persisted theme to <html> BEFORE first paint —
// the real no-flash guarantee (NF-THEME-6). It runs when the browser parses the prerendered
// `index.html`, i.e. before the render-blocking CSS and long before the deferred app bundle
// (where `applyStoredTheme` used to run, which is only "before hydration", not before paint).
// It is a self-contained mirror of `resolveDark`/`readThemePref`/`prefersDark` in theme.ts
// (KEEP IN SYNC) since an inline script cannot import. React hydrates this <script> node as-is
// and never re-runs it, so the theme is applied exactly once.
const THEME_SCRIPT = `(function(){try{var k="cbranch.ui.theme";var p=localStorage.getItem(k);if(p!=="light"&&p!=="dark"&&p!=="system")p="system";var dark=p==="dark"||(p==="system"&&typeof matchMedia==="function"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",dark);}catch(e){}})();`;

export function Layout({ children }: { readonly children: React.ReactNode }) {
    return (
        // The prerendered `index.html` shell is built in Node with no `.dark` class (the build
        // can't know the user's stored preference), but THEME_SCRIPT (below) toggles it on the
        // live <html> before first paint. That makes the live `<html class>` legitimately differ
        // from the shell, so suppress the (expected) hydration mismatch on this one element —
        // React adopts the live attribute rather than stripping it.
        <html lang="en" suppressHydrationWarning>
            <head>
                <meta charSet="UTF-8" />
                <meta
                    name="viewport"
                    content="width=device-width, initial-scale=1.0"
                />
                <meta name="apple-mobile-web-app-title" content="cBranch" />
                <meta name="theme-color" content="#2bc6ad" />
                {/* Must run before <Links> so the right theme is active when the CSS applies. */}
                <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
                <title>cBranch</title>
                <Meta />
                <Links />
            </head>
            <body>
                {children}
                <ScrollRestoration />
                <Scripts />
            </body>
        </html>
    );
}

/** A route miss should be recoverable, not React Router's unstyled fallback page. */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
    const missingRoute = isRouteErrorResponse(error) && error.status === 404;

    return (
        <main className="grid min-h-dvh place-items-center bg-muted/20 p-5">
            <section className="w-full max-w-lg border bg-background shadow-sm">
                <div className="bg-primary h-1" />
                <div className="grid gap-5 p-6 sm:p-8">
                    <p className="text-muted-foreground font-mono text-xs tracking-widest uppercase">
                        {missingRoute ? '404 / Route not found' : 'Route error'}
                    </p>
                    <div className="grid gap-2">
                        <h1 className="text-2xl font-semibold tracking-tight">
                            {missingRoute
                                ? 'This workspace link no longer exists.'
                                : 'cbranch could not open this page.'}
                        </h1>
                        <p className="text-muted-foreground max-w-md text-sm leading-6">
                            {missingRoute
                                ? 'Workspace URLs now begin with /w. The link may be outdated or incomplete.'
                                : 'Return to the workspace overview and try again.'}
                        </p>
                    </div>
                    <div>
                        <a
                            href="/"
                            className="bg-primary text-primary-foreground inline-flex h-9 items-center px-4 text-sm font-medium hover:bg-primary/90"
                        >
                            Return to cbranch
                        </a>
                    </div>
                </div>
            </section>
        </main>
    );
}

export default function Root() {
    // A stable loading shell prevents server prerendering from guessing a browser or
    // Tauri endpoint. The real connection starts only after browser hydration.
    const [hydrated, setHydrated] = useState(false);
    useEffect(() => setHydrated(true), []);
    if (!hydrated)
        return <div className="min-h-dvh bg-background" aria-busy="true" />;

    const desktop = isDesktopSurface();
    const initialEndpoint = desktop
        ? undefined
        : defaultHostEndpoint(window.location);

    return (
        <ConnectionProvider initialEndpoint={initialEndpoint}>
            <ConnectionGate desktop={desktop} />
        </ConnectionProvider>
    );
}

function ConnectionGate({ desktop }: { readonly desktop: boolean }) {
    const { endpoint, status, error, connect, retry } = useConnection();

    if (desktop && (endpoint === undefined || status === 'failed'))
        return (
            <ConnectionProfilesScreen
                connectionError={error}
                onConnect={connect}
                onRetry={retry}
            />
        );

    if (status === 'failed' && endpoint !== undefined)
        return (
            <ConnectionFailureScreen
                endpoint={endpoint.rpcUrl}
                error={error}
                onRetry={retry}
            />
        );

    if (status !== 'connected' && status !== 'reconnecting')
        return (
            <main className="grid min-h-dvh place-items-center bg-muted/20">
                <p role="status" className="text-muted-foreground text-sm">
                    Connecting to cbranch…
                </p>
            </main>
        );

    return (
        <>
            <SyncRouteToStore />
            <Outlet />
        </>
    );
}
