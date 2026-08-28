// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { type CbranchApi } from '../rpc/api';
import { ApiProvider } from '../rpc/ApiProvider';
import { useUiStore } from '../state/store';
import { PluginCommandResultDialog, PluginsDialog } from './PluginsDialog';

const repository = {
    id: 'official-repository',
    kind: 'https',
    url: 'https://plugins.example.test',
    trustState: 'trusted',
    freshness: 'fresh',
    credentialState: 'not needed',
};

const untrustedRepository = {
    ...repository,
    trustState: 'untrusted' as const,
    freshness: 'unknown' as const,
};

afterEach(() =>
    useUiStore.setState({
        pluginsDialogOpen: false,
        pluginCommandResult: null,
    }),
);

describe('PluginsDialog', () => {
    test('wraps unbroken command output inside its result dialog', () => {
        const output = `repoId:${'a'.repeat(64)}`;
        useUiStore.setState({
            pluginCommandResult: { title: 'Plugin result', output },
        });

        render(<PluginCommandResultDialog />);

        const description = screen.getByText(output);
        expect(description.className).toContain('break-all');
        expect(description.className).toContain('whitespace-pre-wrap');
    });

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

        fireEvent.click(screen.getByRole('tab', { name: 'Repositories' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Browse' }));

        expect((await screen.findByRole('alert')).textContent).toContain(
            'Catalog verification failed.',
        );
    });

    test('guides untrusted repositories through publisher trust and removal', async () => {
        const remove = vi.fn(async () => undefined);
        const refresh = vi.fn(async () => undefined);
        const api = {
            pluginRepositoryList: vi.fn(async () => [untrustedRepository]),
            pluginList: vi.fn(async () => []),
            pluginRepositoryRefresh: refresh,
            pluginRepositoryRemove: remove,
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

        fireEvent.click(screen.getByRole('tab', { name: 'Repositories' }));
        expect(
            await screen.findByText(/Fetch the publisher fingerprint/),
        ).toBeTruthy();
        expect(
            (
                screen.getByRole('button', {
                    name: 'Browse',
                }) as HTMLButtonElement
            ).disabled,
        ).toBe(true);
        fireEvent.click(
            screen.getByRole('button', { name: 'Fetch publisher' }),
        );
        await waitFor(() =>
            expect(refresh).toHaveBeenCalledWith(repository.id),
        );
        fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
        await waitFor(() => expect(remove).toHaveBeenCalledWith(repository.id));
    });

    test('offers explicit publisher trust after a fingerprint is fetched', async () => {
        const trust = vi.fn(async () => ({ ...repository }));
        const api = {
            pluginRepositoryList: vi.fn(async () => [
                {
                    ...untrustedRepository,
                    publisherFingerprint: 'sha256:publisher',
                },
            ]),
            pluginList: vi.fn(async () => []),
            pluginPublisherTrust: trust,
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

        fireEvent.click(screen.getByRole('tab', { name: 'Repositories' }));
        expect(await screen.findByText('sha256:publisher')).toBeTruthy();
        expect(
            screen.getByText(/Compare this fingerprint through an independent/),
        ).toBeTruthy();
        fireEvent.click(
            screen.getByRole('button', {
                name: 'I compared it, trust publisher',
            }),
        );
        await waitFor(() =>
            expect(trust).toHaveBeenCalledWith(
                repository.id,
                'sha256:publisher',
            ),
        );
    });

    test('requires a reviewed manifest before installation', async () => {
        const api = {
            pluginRepositoryList: vi.fn(async () => [repository]),
            pluginList: vi.fn(async () => []),
            pluginCatalogList: vi.fn(async () => [
                {
                    pluginId: 'com.example.release',
                    version: '1.2.3',
                    publisherFingerprint: 'sha256:publisher',
                    artifactPath: 'release.cbranch-plugin',
                    artifactSha256: `sha256:${'a'.repeat(64)}`,
                    artifactLength: 1,
                    minimumCbranchVersion: '0.2.0',
                    pluginContractVersion: 1,
                    capabilityDigest: `sha256:${'b'.repeat(64)}`,
                    releaseNotes: 'Fixes release discovery.',
                    advisoryIds: ['CVE-2026-0001'],
                },
            ]),
            pluginInstallReview: vi.fn(async () => ({
                target: {
                    pluginId: 'com.example.release',
                    version: '1.2.3',
                    publisherFingerprint: 'sha256:publisher',
                    artifactPath: 'release.cbranch-plugin',
                    artifactSha256: `sha256:${'a'.repeat(64)}`,
                    artifactLength: 1,
                    minimumCbranchVersion: '0.2.0',
                    pluginContractVersion: 1,
                    capabilityDigest: `sha256:${'b'.repeat(64)}`,
                    releaseNotes: 'Fixes release discovery.',
                    advisoryIds: ['CVE-2026-0001'],
                },
                manifest: {
                    displayName: 'Release',
                    version: '1.2.3',
                    publisherFingerprint: 'sha256:publisher',
                    capabilities: ['ui.contribute'],
                    engines: {
                        cbranch: '>=0.2.0 <1.0.0',
                        pluginContract: 1,
                    },
                    automation: [],
                    contributes: {
                        commands: [{ id: 'release.run', title: 'Run release' }],
                        panels: [],
                    },
                },
            })),
            pluginInstall: vi.fn(async () => ({})),
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

        fireEvent.click(screen.getByRole('tab', { name: 'Repositories' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Browse' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Install' }));

        expect(await screen.findByText('Review plugin install')).toBeTruthy();
        expect(
            screen.getByText(/Requested capabilities: ui.contribute/),
        ).toBeTruthy();
        expect(
            screen.getByText(/Release notes: Fixes release discovery/),
        ).toBeTruthy();
        expect(screen.getByText(/CVE-2026-0001/)).toBeTruthy();
        expect(api.pluginInstall).not.toHaveBeenCalled();
        fireEvent.click(
            screen.getByRole('button', { name: 'Confirm install' }),
        );
        await waitFor(() =>
            expect(api.pluginInstall).toHaveBeenCalledWith(
                expect.objectContaining({
                    artifactSha256: `sha256:${'a'.repeat(64)}`,
                }),
            ),
        );
        expect(screen.queryByText('Review plugin install')).toBeNull();
        expect(
            screen
                .getByRole('tab', { name: 'Installed' })
                .getAttribute('aria-selected'),
        ).toBe('true');
    });

    test('appends audit pages when loading more', async () => {
        const auditList = vi
            .fn()
            .mockResolvedValueOnce({
                events: [
                    {
                        at: 1,
                        action: 'publisher.trust',
                        outcome: 'allowed',
                    },
                ],
                nextCursor: '1',
            })
            .mockResolvedValueOnce({
                events: [
                    {
                        at: 2,
                        action: 'repository.remove',
                        outcome: 'allowed',
                    },
                ],
            });
        const api = {
            pluginRepositoryList: vi.fn(async () => []),
            pluginList: vi.fn(async () => []),
            pluginRuntimeStatus: vi.fn(async () => ({ available: true })),
            pluginAuditList: auditList,
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

        fireEvent.click(screen.getByRole('tab', { name: 'Audit' }));
        expect(await screen.findByText(/publisher\.trust/)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
        expect(await screen.findByText(/repository\.remove/)).toBeTruthy();
        expect(screen.getByText(/publisher\.trust/)).toBeTruthy();
        expect(auditList).toHaveBeenNthCalledWith(1, { cursor: undefined });
        expect(auditList).toHaveBeenNthCalledWith(2, { cursor: '1' });
    });
});
