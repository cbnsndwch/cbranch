// @vitest-environment jsdom
import { AppSettings, HistoryColumnVisibility } from '@cbranch/rpc-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { type CbranchApi } from '../rpc/api';
import { ApiProvider } from '../rpc/ApiProvider';
import { HistoryColumnMenu } from './HistoryColumnMenu';

const settings = (columns: HistoryColumnVisibility) =>
    new AppSettings({
        theme: 'system',
        locale: 'en',
        keybindings: [],
        columns,
    });

const allShown = new HistoryColumnVisibility({
    authorName: true,
    avatar: true,
    date: true,
    sha: true,
});

const makeApi = (over: Partial<CbranchApi> = {}): CbranchApi =>
    ({
        appSettingsGet: vi.fn(async () => settings(allShown)),
        appSettingsSet: vi.fn(async () => settings(allShown)),
        ...over,
    }) as unknown as CbranchApi;

const renderMenu = (api: CbranchApi) => {
    const qc = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(
        <QueryClientProvider client={qc}>
            <ApiProvider api={api}>
                <HistoryColumnMenu />
            </ApiProvider>
        </QueryClientProvider>,
    );
};

afterEach(() => cleanup());

describe('HistoryColumnMenu', () => {
    test('toggling a column persists the flipped visibility via appSettingsSet', async () => {
        const setFn = vi.fn(async () => settings(allShown));
        renderMenu(makeApi({ appSettingsSet: setFn }));

        fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
        const shaItem = await screen.findByText('SHA');
        fireEvent.click(shaItem);

        await waitFor(() => expect(setFn).toHaveBeenCalledTimes(1));
        const patch = setFn.mock.calls[0][0] as {
            columns: HistoryColumnVisibility;
        };
        // SHA flips off; the rest stay shown.
        expect(patch.columns.sha).toBe(false);
        expect(patch.columns.authorName).toBe(true);
    });
});
