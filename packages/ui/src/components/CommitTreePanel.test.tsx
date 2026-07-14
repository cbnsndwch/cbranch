// @vitest-environment jsdom
import { CommitTree, Oid, RepoId } from '@cbranch/rpc-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { type CbranchApi } from '../rpc/api';
import { ApiProvider } from '../rpc/ApiProvider';
import { CommitTreePanel } from './CommitTreePanel';

const repoId = RepoId.make('repo-1');
const oid = Oid.make('0123456789abcdef0123456789abcdef01234567');

const renderWithApi = (ui: ReactNode, api: CbranchApi) =>
    render(
        <QueryClientProvider
            client={
                new QueryClient({
                    defaultOptions: { queries: { retry: false } },
                })
            }
        >
            <ApiProvider api={api}>{ui}</ApiProvider>
        </QueryClientProvider>,
    );

beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        value: 600,
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
        configurable: true,
        value: 400,
    });
});

afterEach(() => {
    cleanup();
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        value: 0,
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
        configurable: true,
        value: 0,
    });
});

describe('CommitTreePanel', () => {
    test('renders the selected commit tree rather than requesting a diff', async () => {
        const api = {
            commitTree: vi.fn(
                async () =>
                    new CommitTree({
                        paths: [
                            'README.md',
                            'src/current.ts',
                            'src/unchanged.ts',
                        ],
                    }),
            ),
            commitDiff: vi.fn(),
        } as unknown as CbranchApi;

        renderWithApi(<CommitTreePanel repoId={repoId} oid={oid} />, api);

        expect(await screen.findByText('README.md')).toBeTruthy();
        expect(screen.getByText('src')).toBeTruthy();
        expect(screen.getByText('unchanged.ts')).toBeTruthy();
        expect(api.commitTree).toHaveBeenCalledWith(repoId, oid);
        expect(api.commitDiff).not.toHaveBeenCalled();
    });

    test('preserves the no-selected-commit empty state without querying', () => {
        const api = { commitTree: vi.fn() } as unknown as CbranchApi;

        renderWithApi(<CommitTreePanel repoId={repoId} oid={null} />, api);

        expect(
            screen.getByText('Select a commit to see its file tree.'),
        ).toBeTruthy();
        expect(api.commitTree).not.toHaveBeenCalled();
    });
});
