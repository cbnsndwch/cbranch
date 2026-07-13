import { CBRANCH_PROTOCOL_VERSION } from '@cbranch/rpc-contract';
import { describe, expect, test, vi } from 'vitest';

import { probeCbranchServer } from './bridge';

describe('probeCbranchServer', () => {
    test('accepts a compatible cbranch health response', async () => {
        const request = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({
                        service: 'cbranch',
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
});
