// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { type CbranchApi } from '../rpc/api';
import { ApiProvider } from '../rpc/ApiProvider';
import { PluginPanels } from './PluginPanels';

describe('PluginPanels', () => {
    test('renders only enabled panels in the host-owned plugins region', async () => {
        const api = {
            pluginList: vi.fn(async () => [
                {
                    enabled: true,
                    lock: {
                        pluginId: 'com.example.release',
                        publisherFingerprint: 'sha256:publisher',
                    },
                    contributions: {
                        commands: [],
                        panels: [
                            {
                                id: 'status',
                                title: 'Release status',
                                placement: 'plugins',
                                content: {
                                    _tag: 'keyValue',
                                    items: [{ label: 'State', value: 'Ready' }],
                                },
                            },
                        ],
                    },
                },
            ]),
        } as unknown as CbranchApi;
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });

        render(
            <QueryClientProvider client={queryClient}>
                <ApiProvider api={api}>
                    <PluginPanels />
                </ApiProvider>
            </QueryClientProvider>,
        );

        expect(
            await screen.findByRole('region', { name: 'Plugin panels' }),
        ).toBeTruthy();
        expect(screen.getByText('Release status')).toBeTruthy();
        expect(
            screen.getByText('com.example.release · sha256:publisher'),
        ).toBeTruthy();
        expect(screen.getByText('Ready')).toBeTruthy();
    });
});
