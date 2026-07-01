// @vitest-environment jsdom
import { Oid, RepoId } from '@cbranch/rpc-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { type CbranchApi } from '../rpc/api';
import { ApiProvider } from '../rpc/ApiProvider';
import { useUiStore } from '../state/store';
import { GoToCommitDialog } from './GoToCommitDialog';

const repoId = RepoId.make('repo-1');
const fullOid = Oid.make('a'.repeat(40));

const makeApi = (commitDetail: CbranchApi['commitDetail']): CbranchApi =>
    ({ commitDetail }) as unknown as CbranchApi;

const renderDialog = (api: CbranchApi) => {
    const qc = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(
        <QueryClientProvider client={qc}>
            <ApiProvider api={api}>
                <GoToCommitDialog repoId={repoId} />
            </ApiProvider>
        </QueryClientProvider>,
    );
};

beforeEach(() => {
    useUiStore.setState({ goToDialogOpen: false, gotoRequest: null });
});
afterEach(() => cleanup());

describe('GoToCommitDialog', () => {
    test('renders nothing when closed', () => {
        renderDialog(makeApi(vi.fn()));
        expect(screen.queryByText('Go to commit')).toBeNull();
    });

    test('resolving a ref dispatches a goto request with the full oid and closes', async () => {
        const detailFn = vi.fn(async () => ({ oid: fullOid }) as never);
        renderDialog(makeApi(detailFn));
        useUiStore.setState({ goToDialogOpen: true });

        const input = await screen.findByLabelText('Commit hash or ref');
        fireEvent.change(input, { target: { value: 'HEAD~2' } });
        fireEvent.click(screen.getByRole('button', { name: 'Go' }));

        await waitFor(() =>
            expect(detailFn).toHaveBeenCalledWith(repoId, 'HEAD~2'),
        );
        await waitFor(() =>
            expect(useUiStore.getState().gotoRequest).toEqual({ oid: fullOid }),
        );
        expect(useUiStore.getState().goToDialogOpen).toBe(false);
    });

    test('an unresolvable input shows an inline error and leaves the request unchanged', async () => {
        const detailFn = vi.fn(async () => {
            throw new Error('unknown revision');
        });
        renderDialog(makeApi(detailFn));
        useUiStore.setState({ goToDialogOpen: true });

        const input = await screen.findByLabelText('Commit hash or ref');
        fireEvent.change(input, { target: { value: 'nope' } });
        fireEvent.click(screen.getByRole('button', { name: 'Go' }));

        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(useUiStore.getState().gotoRequest).toBeNull();
        // Dialog stays open so the user can correct the input.
        expect(useUiStore.getState().goToDialogOpen).toBe(true);
    });
});
