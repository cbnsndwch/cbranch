import { describe, expect, test, vi } from 'vitest';

import { makeHttpsPluginRepositoryTransport } from './plugin-repository-transport';

describe('HTTPS plugin repository transport', () => {
    test('pins requests to the configured origin and bounds target bytes', async () => {
        const fetch = vi.fn(async (url: URL | string, init?: RequestInit) => {
            expect(String(url)).toBe(
                'https://plugins.example.test/catalog/targets.json',
            );
            expect(init?.redirect).toBe('manual');
            expect(init?.headers).toEqual({ authorization: 'Bearer token' });
            return new Response('metadata', {
                headers: { 'content-length': '8' },
            });
        });
        const transport = makeHttpsPluginRepositoryTransport({
            url: 'https://plugins.example.test/catalog',
            credential: 'token',
            fetch: fetch as unknown as typeof globalThis.fetch,
        });

        await expect(transport.fetchMetadata('targets.json')).resolves.toEqual(
            new TextEncoder().encode('metadata'),
        );
    });

    test('rejects redirects, path traversal, and oversized responses', async () => {
        const redirecting = makeHttpsPluginRepositoryTransport({
            url: 'https://plugins.example.test',
            fetch: async () => new Response(null, { status: 302 }),
        });
        await expect(
            redirecting.fetchMetadata('timestamp.json'),
        ).rejects.toThrow('redirects');
        await expect(
            redirecting.fetchMetadata('../timestamp.json'),
        ).rejects.toThrow('unsafe');

        const oversized = makeHttpsPluginRepositoryTransport({
            url: 'https://plugins.example.test',
            fetch: async () =>
                new Response('x', {
                    headers: { 'content-length': String(6 * 1024 * 1024) },
                }),
        });
        await expect(oversized.fetchMetadata('timestamp.json')).rejects.toThrow(
            'size limit',
        );
    });
});
