// @vitest-environment jsdom

import {
    CBRANCH_BACKEND_VERSION,
    CBRANCH_PROTOCOL_VERSION,
} from '@cbranch/rpc-contract';
import { render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { makeHostEndpoint } from './client';
import { ConnectionProvider, useConnection } from './connection-provider';

const runtimes: Array<{
    readonly dispose: ReturnType<typeof vi.fn>;
}> = [];

let systemInfo = {
    version: CBRANCH_BACKEND_VERSION,
    protocolVersion: CBRANCH_PROTOCOL_VERSION,
};

vi.mock('./client', async importOriginal => {
    const actual = await importOriginal<typeof import('./client')>();
    return {
        ...actual,
        makeAppRuntime: vi.fn(() => {
            const runtime = {
                runPromise: vi.fn(async () => systemInfo),
                dispose: vi.fn(async () => undefined),
            };
            runtimes.push(runtime);
            return runtime;
        }),
    };
});

function Status() {
    const { status } = useConnection();
    return <output>{status}</output>;
}

afterEach(() => {
    runtimes.splice(0);
    systemInfo = {
        version: CBRANCH_BACKEND_VERSION,
        protocolVersion: CBRANCH_PROTOCOL_VERSION,
    };
    vi.unstubAllEnvs();
    vi.resetModules();
});

describe('ConnectionProvider', () => {
    test('creates a fresh runtime after Strict Mode cleans up the first effect', async () => {
        render(
            <StrictMode>
                <ConnectionProvider
                    initialEndpoint={makeHostEndpoint(
                        'ws://127.0.0.1:7420/rpc',
                    )}
                >
                    <Status />
                </ConnectionProvider>
            </StrictMode>,
        );

        expect(await screen.findByText('connected')).toBeTruthy();
        expect(runtimes).toHaveLength(2);
        expect(runtimes[0]!.dispose).toHaveBeenCalledOnce();
    });

    test('accepts the exact canary server release', async () => {
        vi.stubEnv('VITE_CBRANCH_CANARY', '1');
        vi.stubEnv('VITE_CBRANCH_VERSION', 'v0.2.2-rc.18');
        systemInfo = {
            version: '0.2.2-rc.18',
            protocolVersion: CBRANCH_PROTOCOL_VERSION,
        };
        vi.resetModules();
        const {
            ConnectionProvider: CanaryConnectionProvider,
            useConnection: useCanaryConnection,
        } = await import('./connection-provider');

        function CanaryStatus() {
            const { status } = useCanaryConnection();
            return <output>{status}</output>;
        }

        render(
            <CanaryConnectionProvider
                initialEndpoint={makeHostEndpoint('ws://127.0.0.1:7421/rpc')}
            >
                <CanaryStatus />
            </CanaryConnectionProvider>,
        );

        expect(await screen.findByText('connected')).toBeTruthy();
    });
});
