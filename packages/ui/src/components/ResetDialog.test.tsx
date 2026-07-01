// @vitest-environment jsdom
import { RepoId } from '@cbranch/rpc-contract';
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
import { ResetDialog } from './ResetDialog';

const repoId = RepoId.make('repo-1');

const makeApi = (resetTo: CbranchApi['resetTo']): CbranchApi =>
    ({ resetTo }) as unknown as CbranchApi;

const renderDialog = (api: CbranchApi) => {
    const qc = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(
        <QueryClientProvider client={qc}>
            <ApiProvider api={api}>
                <ResetDialog repoId={repoId} />
            </ApiProvider>
        </QueryClientProvider>,
    );
};

beforeEach(() => {
    useUiStore.setState({ resetDialog: null });
});
afterEach(() => cleanup());

describe('ResetDialog', () => {
    test('renders nothing when closed', () => {
        renderDialog(makeApi(vi.fn(async () => undefined)));
        expect(screen.queryByText('Reset to commit')).toBeNull();
    });

    test('pre-seeds the target and a mixed reset runs directly', async () => {
        const resetFn = vi.fn(async () => undefined);
        renderDialog(makeApi(resetFn));
        useUiStore.setState({ resetDialog: { target: 'abc123' } });

        const input = (await screen.findByLabelText(
            'Target commit',
        )) as HTMLInputElement;
        expect(input.value).toBe('abc123');

        // mixed is the default mode; Reset runs it with no extra confirmation.
        fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
        await waitFor(() =>
            expect(resetFn).toHaveBeenCalledWith(repoId, 'mixed', 'abc123'),
        );
        // Dialog closes on success.
        await waitFor(() =>
            expect(useUiStore.getState().resetDialog).toBeNull(),
        );
    });

    test('a hard reset is gated behind a destructive confirmation', async () => {
        const resetFn = vi.fn(async () => undefined);
        renderDialog(makeApi(resetFn));
        useUiStore.setState({ resetDialog: { target: 'deadbeef' } });

        await screen.findByLabelText('Target commit');
        fireEvent.click(screen.getByLabelText('hard reset'));
        fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

        // Nothing runs yet — the guard is up.
        expect(resetFn).not.toHaveBeenCalled();
        expect(
            await screen.findByText(/Hard reset — discard working-tree/),
        ).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: 'Hard reset' }));
        await waitFor(() =>
            expect(resetFn).toHaveBeenCalledWith(repoId, 'hard', 'deadbeef'),
        );
    });

    test('Reset is disabled when the target is empty', async () => {
        renderDialog(makeApi(vi.fn(async () => undefined)));
        useUiStore.setState({ resetDialog: { target: '' } });
        const btn = (await screen.findByRole('button', {
            name: 'Reset',
        })) as HTMLButtonElement;
        expect(btn.disabled).toBe(true);
    });
});
