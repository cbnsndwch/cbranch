import {
    CBRANCH_BACKEND_VERSION,
    CBRANCH_PROTOCOL_VERSION,
} from '@cbranch/rpc-contract';
import { afterEach, describe, expect, test, vi } from 'vitest';

const tauriWindow = vi.hoisted(() => ({ getCurrentWindow: vi.fn() }));

vi.mock('@tauri-apps/api/window', () => tauriWindow);

import { probeCbranchServer, setDesktopWindowTitle } from './bridge';

describe('probeCbranchServer', () => {
    test('accepts a compatible cbranch health response', async () => {
        const request = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({
                        service: 'cbranch',
                        version: CBRANCH_BACKEND_VERSION,
                        protocolVersion: CBRANCH_PROTOCOL_VERSION,
                    }),
                ),
        );

        await expect(
            probeCbranchServer('http://127.0.0.1:7420', request),
        ).resolves.toEqual({ status: 'ready' });
        expect(request).toHaveBeenCalledWith(
            new URL('http://127.0.0.1:7420/healthz'),
            { cache: 'no-store' },
        );
    });

    test('reports an unavailable forwarded server', async () => {
        const request = vi.fn(async () => {
            throw new TypeError('fetch failed');
        });

        await expect(
            probeCbranchServer('http://127.0.0.1:7420', request),
        ).resolves.toEqual({ status: 'missing' });
    });

    test('reports an unexpected or incompatible response', async () => {
        const unexpected = vi.fn(
            async () => new Response('<html>other</html>'),
        );
        const incompatible = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({ service: 'cbranch', protocolVersion: 2 }),
                ),
        );

        await expect(
            probeCbranchServer('http://127.0.0.1:7420', unexpected),
        ).resolves.toEqual({ status: 'incompatible' });
        await expect(
            probeCbranchServer('http://127.0.0.1:7420', incompatible),
        ).resolves.toEqual({ status: 'incompatible', protocolVersion: 2 });
    });

    test('requires a server release at least as new as the desktop client', async () => {
        const old = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({
                        service: 'cbranch',
                        protocolVersion: CBRANCH_PROTOCOL_VERSION,
                        version: '0.1.2',
                    }),
                ),
        );
        const missingVersion = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({
                        service: 'cbranch',
                        protocolVersion: CBRANCH_PROTOCOL_VERSION,
                    }),
                ),
        );

        await expect(
            probeCbranchServer('http://127.0.0.1:7420', old),
        ).resolves.toEqual({
            status: 'incompatible',
            protocolVersion: CBRANCH_PROTOCOL_VERSION,
            version: '0.1.2',
        });
        await expect(
            probeCbranchServer('http://127.0.0.1:7420', missingVersion),
        ).resolves.toEqual({
            status: 'incompatible',
            protocolVersion: CBRANCH_PROTOCOL_VERSION,
        });
    });
});

describe('setDesktopWindowTitle', () => {
    afterEach(() => {
        tauriWindow.getCurrentWindow.mockReset();
        vi.unstubAllGlobals();
    });

    test('defers the Tauri window import and updates the native title on desktop', async () => {
        const setTitle = vi.fn(async () => undefined);
        tauriWindow.getCurrentWindow.mockReturnValue({ setTitle });
        vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });

        await setDesktopWindowTitle('Client A · api • cBranch');

        expect(tauriWindow.getCurrentWindow).toHaveBeenCalledOnce();
        expect(setTitle).toHaveBeenCalledWith('Client A · api • cBranch');
    });
});
