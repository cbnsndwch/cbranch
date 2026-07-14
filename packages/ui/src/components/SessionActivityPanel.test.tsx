// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { RepoId } from '@cbranch/rpc-contract';

import { type CbranchApi } from '../rpc/api';
import { ApiProvider } from '../rpc/ApiProvider';
import { useUiStore } from '../state/store';
import { SessionActivityPanel } from './SessionActivityPanel';

const commandLogList = vi.fn(async () => []);
const commandLogSubscribe = vi.fn(() => () => undefined);
const api = {
    commandLogList,
    commandLogSubscribe,
} as unknown as CbranchApi;

beforeEach(() => {
    useUiStore.setState({
        sessionActivities: [],
        sessionActivityOpen: false,
        sessionActivityPinned: false,
    });
    commandLogList.mockClear();
    commandLogSubscribe.mockClear();
});

describe('SessionActivityPanel', () => {
    test('shows a live transcript and lets the user pin or close it', async () => {
        const id = useUiStore.getState().startSessionActivity({
            repoId: RepoId.make('repo-1'),
            kind: 'pull',
            label: 'Pulling',
        });
        useUiStore
            .getState()
            .appendSessionActivity(id, 'Receiving objects: 100%');

        render(
            <QueryClientProvider client={new QueryClient()}>
                <ApiProvider api={api}>
                    <SessionActivityPanel />
                </ApiProvider>
            </QueryClientProvider>,
        );

        expect(
            await screen.findByRole('dialog', { name: 'Session activity' }),
        ).toBeTruthy();
        expect(
            screen.getByText(
                (_content, element) =>
                    element?.tagName === 'PRE' &&
                    element.textContent?.includes('Receiving objects: 100%') ===
                        true,
            ),
        ).toBeTruthy();
        fireEvent.click(
            screen.getByRole('button', { name: 'Keep activity panel open' }),
        );
        expect(useUiStore.getState().sessionActivityPinned).toBe(true);
        fireEvent.click(
            screen.getByRole('button', { name: 'Close session activity' }),
        );
        expect(screen.queryByRole('dialog')).toBeNull();
    });
});
