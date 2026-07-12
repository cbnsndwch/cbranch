// @vitest-environment jsdom

import { describe, expect, test } from 'vitest';

import {
    defaultHostEndpoint,
    makeHostEndpoint,
    resolveHostUrl,
} from './client';

describe('host endpoint selection', () => {
    test('preserves the browser same-origin RPC default', () => {
        expect(
            defaultHostEndpoint({
                protocol: 'https:',
                host: 'cbranch.test:7443',
            }),
        ).toEqual({
            rpcUrl: 'wss://cbranch.test:7443/rpc',
            httpBaseUrl: 'https://cbranch.test:7443/',
        });
    });

    test('accepts an explicit forwarded loopback endpoint', () => {
        expect(makeHostEndpoint('ws://127.0.0.1:51234/rpc')).toEqual({
            rpcUrl: 'ws://127.0.0.1:51234/rpc',
            httpBaseUrl: 'http://127.0.0.1:51234/',
        });
    });

    test('resolves side-channel descriptors against the selected backend only', () => {
        const endpoint = makeHostEndpoint('ws://127.0.0.1:51234/rpc');
        expect(
            resolveHostUrl(endpoint, '/sidechannel/archive?repoId=abc'),
        ).toBe('http://127.0.0.1:51234/sidechannel/archive?repoId=abc');
        expect(
            resolveHostUrl(endpoint, 'https://images.example/avatar.png'),
        ).toBe('https://images.example/avatar.png');
    });

    test('keeps browser same-origin side-channel URLs relative', () => {
        const endpoint = defaultHostEndpoint(window.location);
        expect(
            resolveHostUrl(endpoint, '/sidechannel/archive?repoId=abc'),
        ).toBe('/sidechannel/archive?repoId=abc');
    });

    test('rejects an endpoint that cannot be the typed RPC bus', () => {
        expect(() => makeHostEndpoint('http://127.0.0.1:7420/rpc')).toThrow(
            'ws:// or wss://',
        );
        expect(() => makeHostEndpoint('ws://127.0.0.1:7420/not-rpc')).toThrow(
            'end with /rpc',
        );
    });
});
