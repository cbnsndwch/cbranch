// @vitest-environment jsdom
import {
    PatchApplyReport,
    PatchApplyResult,
    RepoId,
} from '@cbranch/rpc-contract';
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
import { PatchApplyDialog } from './PatchApplyDialog';

const repoId = RepoId.make('r1');

const makeApi = (over: Partial<CbranchApi> = {}): CbranchApi =>
    ({
        patchInspect: vi.fn(
            async () => new PatchApplyReport({ clean: true, files: ['a.txt'] }),
        ),
        patchApply: vi.fn(
            async () =>
                new PatchApplyResult({
                    applied: true,
                    message: 'Patch applied.',
                }),
        ),
        ...over,
    }) as unknown as CbranchApi;

const renderDialog = (api: CbranchApi) => {
    const qc = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(
        <QueryClientProvider client={qc}>
            <ApiProvider api={api}>
                <PatchApplyDialog repoId={repoId} />
            </ApiProvider>
        </QueryClientProvider>,
    );
};

beforeEach(() => {
    useUiStore.setState({ patchApplyDialogOpen: true });
});
afterEach(() => cleanup());

describe('PatchApplyDialog', () => {
    test('Check dry-runs the pasted patch and reports the result', async () => {
        const inspectFn = vi.fn(
            async () => new PatchApplyReport({ clean: true, files: ['a.txt'] }),
        );
        renderDialog(makeApi({ patchInspect: inspectFn }));

        fireEvent.change(screen.getByLabelText('Patch text'), {
            target: { value: 'diff --git a/a b/a\n' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Check' }));

        await waitFor(() =>
            expect(inspectFn).toHaveBeenCalledWith(repoId, {
                patch: 'diff --git a/a b/a\n',
                mode: 'working',
                threeWay: false,
            }),
        );
        expect(await screen.findByText(/Applies cleanly/)).toBeTruthy();
    });

    test('Apply applies the patch in the selected mode', async () => {
        const applyFn = vi.fn(
            async () =>
                new PatchApplyResult({
                    applied: true,
                    message: 'Patch applied as commit(s).',
                }),
        );
        renderDialog(makeApi({ patchApply: applyFn }));

        fireEvent.change(screen.getByLabelText('Patch text'), {
            target: { value: 'a patch' },
        });
        fireEvent.click(screen.getByLabelText('am mode'));
        fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

        await waitFor(() =>
            expect(applyFn).toHaveBeenCalledWith(repoId, {
                patch: 'a patch',
                mode: 'am',
                threeWay: false,
            }),
        );
    });
});
