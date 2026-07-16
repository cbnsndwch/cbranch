// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { type CbranchApi } from '../rpc/api';
import { ApiProvider } from '../rpc/ApiProvider';
import { useUiStore } from '../state/store';
import { PluginsDialog } from './PluginsDialog';

const repository = {
    id: 'official-repository',
    kind: 'https',
    url: 'https://plugins.example.test',
    trustState: 'trusted',
    freshness: 'fresh',
    credentialState: 'not needed',
};

afterEach(() => useUiStore.setState({ pluginsDialogOpen: false }));

describe('PluginsDialog', () => {
    test('shows a catalog loading error instead of an empty panel', async () => {
        const api = {
            pluginRepositoryList: vi.fn(async () => [repository]),
            pluginList: vi.fn(async () => []),
            pluginCatalogList: vi.fn(async () => {
                throw new Error('Catalog verification failed.');
            }),
        } as unknown as CbranchApi;
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        useUiStore.setState({ pluginsDialogOpen: true });

        render(
            <QueryClientProvider client={queryClient}>
                <ApiProvider api={api}>
                    <PluginsDialog />
                </ApiProvider>
            </QueryClientProvider>,
        );

        fireEvent.click(await screen.findByRole('button', { name: 'Browse' }));

        expect((await screen.findByRole('alert')).textContent).toContain(
            'Catalog verification failed.',
        );
    });
});
