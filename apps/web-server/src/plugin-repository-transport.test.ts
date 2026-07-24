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
            getCredential: async () => 'token',
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

    test('rejects a credential through its owner after an unauthorized response', async () => {
        const rejectCredential = vi.fn(async () => undefined);
        const transport = makeHttpsPluginRepositoryTransport({
            url: 'https://plugins.example.test',
            getCredential: async () => 'token',
            rejectCredential,
            fetch: async () => new Response(null, { status: 401 }),
        });

        await expect(transport.fetchMetadata('timestamp.json')).rejects.toThrow(
            'HTTP 401',
        );
        expect(rejectCredential).toHaveBeenCalledOnce();
        expect(rejectCredential).toHaveBeenCalledWith('token');
    });

    test('resolves a credential for each request instead of retaining it', async () => {
        const getCredential = vi
            .fn()
            .mockResolvedValueOnce('first-token')
            .mockResolvedValueOnce('second-token');
        const requests: RequestInit[] = [];
        const fetch = vi.fn(async (_url: URL | string, init?: RequestInit) => {
            requests.push(init ?? {});
            return new Response('metadata', {
                headers: { 'content-length': '8' },
            });
        });
        const transport = makeHttpsPluginRepositoryTransport({
            url: 'https://plugins.example.test',
            getCredential,
            fetch: fetch as unknown as typeof globalThis.fetch,
        });

        await transport.fetchMetadata('timestamp.json');
        await transport.fetchMetadata('snapshot.json');

        expect(requests.map(request => request.headers)).toEqual([
            { authorization: 'Bearer first-token' },
            { authorization: 'Bearer second-token' },
        ]);
    });
});
