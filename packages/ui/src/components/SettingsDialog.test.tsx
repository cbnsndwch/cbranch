// @vitest-environment jsdom
import { AppSettings, KeyBinding, RepoId } from '@cbranch/rpc-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { useKeybindings } from '../hooks/use-keybindings';
import { type CbranchApi } from '../rpc/api';
import { ApiProvider } from '../rpc/ApiProvider';
import { useUiStore } from '../state/store';
import { SettingsDialog } from './SettingsDialog';

vi.mock('sonner', () => ({
    toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const repoId = RepoId.make('cfg-repo');

const entries = [
    {
        key: 'user.name',
        value: 'Ada Lovelace',
        scope: 'global',
        origin: 'file:~/.gitconfig',
    },
    {
        key: 'user.email',
        value: 'ada@example.io',
        scope: 'global',
        origin: 'file:~/.gitconfig',
    },
    {
        key: 'core.editor',
        value: 'vim',
        scope: 'local',
        origin: 'file:.git/config',
    },
    {
        key: 'core.bare',
        value: 'false',
        scope: 'system',
        origin: 'file:/etc/gitconfig',
    },
];

const makeApi = (overrides: Partial<CbranchApi> = {}): CbranchApi =>
    ({
        configList: vi.fn(async () => entries),
        configSet: vi.fn(async () => undefined),
        configUnset: vi.fn(async () => undefined),
        appSettingsGet: vi.fn(
            async () =>
                new AppSettings({
                    theme: 'system',
                    locale: 'en',
                    keybindings: [],
                }),
        ),
        appSettingsSet: vi.fn(
            async () =>
                new AppSettings({
                    theme: 'system',
                    locale: 'en',
                    keybindings: [],
                }),
        ),
        recentList: vi.fn(async () => []),
        subscribe: vi.fn(() => () => undefined),
        ...overrides,
    }) as unknown as CbranchApi;

const renderDialog = (api: CbranchApi) => {
    const qc = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(
        <QueryClientProvider client={qc}>
            <ApiProvider api={api}>
                <SettingsDialog />
            </ApiProvider>
        </QueryClientProvider>,
    );
};

const open = (withRepo = true) =>
    act(() => {
        useUiStore.setState({
            activeRepoId: withRepo ? repoId : null,
            settingsDialogOpen: true,
        });
    });

beforeEach(() => {
    if (!Element.prototype.scrollIntoView)
        Element.prototype.scrollIntoView = () => undefined;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        };
    useUiStore.setState({
        activeRepoId: null,
        settingsDialogOpen: false,
        theme: 'system',
    });
    vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('SettingsDialog', () => {
    test('renders nothing when closed', () => {
        renderDialog(makeApi());
        expect(screen.queryByText('Settings')).toBeNull();
    });

    test('with no repo, the git tab prompts to open one (app settings still separate)', async () => {
        renderDialog(makeApi());
        open(false);
        expect(
            await screen.findByText(/Open a repository to view and edit/i),
        ).toBeTruthy();
    });

    test('lists git config entries with scope badges; system rows are not unsettable', async () => {
        renderDialog(makeApi());
        open();
        expect(await screen.findByText('user.name')).toBeTruthy();
        expect(screen.getByText('vim')).toBeTruthy();
        // system scope is read-only → no Unset action for that row.
        expect(screen.queryByLabelText('Unset core.bare')).toBeNull();
        expect(screen.getByLabelText('Unset user.name')).toBeTruthy();
    });

    test('guided Identity prefills from effective config and writes both keys', async () => {
        const api = makeApi();
        renderDialog(api);
        open();
        const name = (await screen.findByLabelText(
            'user.name',
        )) as HTMLInputElement;
        const email = screen.getByLabelText('user.email') as HTMLInputElement;
        // Prefill arrives once configList resolves.
        await waitFor(() => expect(name.value).toBe('Ada Lovelace'));
        expect(email.value).toBe('ada@example.io');
        fireEvent.change(name, { target: { value: 'Grace Hopper' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save identity' }));
        await waitFor(() => {
            expect(api.configSet).toHaveBeenCalledWith(
                repoId,
                'user.name',
                'Grace Hopper',
                'global',
            );
        });
        expect(api.configSet).toHaveBeenCalledWith(
            repoId,
            'user.email',
            'ada@example.io',
            'global',
        );
    });

    test('guided Editor writes core.editor', async () => {
        const api = makeApi();
        renderDialog(api);
        open();
        const editor = (await screen.findByLabelText(
            'core.editor',
        )) as HTMLInputElement;
        fireEvent.change(editor, { target: { value: 'code --wait' } });
        fireEvent.click(editor.parentElement!.querySelector('button')!);
        await waitFor(() => {
            expect(api.configSet).toHaveBeenCalledWith(
                repoId,
                'core.editor',
                'code --wait',
                'global',
            );
        });
    });

    test('guided Credentials writes only a credential.helper name', async () => {
        const api = makeApi();
        renderDialog(api);
        open();
        const helper = (await screen.findByLabelText(
            'credential.helper',
        )) as HTMLInputElement;
        fireEvent.change(helper, { target: { value: 'cache' } });
        fireEvent.click(helper.parentElement!.querySelector('button')!);
        await waitFor(() => {
            expect(api.configSet).toHaveBeenCalledWith(
                repoId,
                'credential.helper',
                'cache',
                'global',
            );
        });
    });

    test('guided Diff/Merge writes tool keys AND the custom .cmd keys (REQ-CFG-003)', async () => {
        const api = makeApi();
        renderDialog(api);
        open();
        fireEvent.change(await screen.findByLabelText('diff.tool'), {
            target: { value: 'mydiff' },
        });
        fireEvent.change(screen.getByLabelText('merge.tool'), {
            target: { value: 'mymerge' },
        });
        fireEvent.change(screen.getByLabelText('difftool command'), {
            target: { value: 'mydiff $LOCAL $REMOTE' },
        });
        fireEvent.change(screen.getByLabelText('mergetool command'), {
            target: { value: 'mymerge $MERGED' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Save tools' }));
        await waitFor(() => {
            expect(api.configSet).toHaveBeenCalledWith(
                repoId,
                'diff.tool',
                'mydiff',
                'global',
            );
        });
        expect(api.configSet).toHaveBeenCalledWith(
            repoId,
            'merge.tool',
            'mymerge',
            'global',
        );
        expect(api.configSet).toHaveBeenCalledWith(
            repoId,
            'difftool.mydiff.cmd',
            'mydiff $LOCAL $REMOTE',
            'global',
        );
        expect(api.configSet).toHaveBeenCalledWith(
            repoId,
            'mergetool.mymerge.cmd',
            'mymerge $MERGED',
            'global',
        );
    });

    test('advanced table adds a key and unsets a writable row', async () => {
        const api = makeApi();
        renderDialog(api);
        open();
        fireEvent.change(await screen.findByLabelText('New config key'), {
            target: { value: 'init.defaultBranch' },
        });
        fireEvent.change(screen.getByLabelText('New config value'), {
            target: { value: 'main' },
        });
        fireEvent.click(screen.getByRole('button', { name: /^Add/ }));
        await waitFor(() => {
            expect(api.configSet).toHaveBeenCalledWith(
                repoId,
                'init.defaultBranch',
                'main',
                'global',
            );
        });
        fireEvent.click(screen.getByLabelText('Unset core.editor'));
        await waitFor(() => {
            expect(api.configUnset).toHaveBeenCalledWith(
                repoId,
                'core.editor',
                'local',
            );
        });
    });

    test('App tab: theme RadioGroup applies + persists; keybinding conflict blocks save', async () => {
        const api = makeApi();
        renderDialog(api);
        open();
        fireEvent.click(screen.getByRole('tab', { name: 'App settings' }));
        // Theme change applies to the store and persists to the host.
        fireEvent.click(await screen.findByLabelText('Dark theme'));
        await waitFor(() => {
            expect(useUiStore.getState().theme).toBe('dark');
        });
        expect(api.appSettingsSet).toHaveBeenCalledWith({ theme: 'dark' });

        // Remap "Find in history" onto the palette chord → conflict → Save disabled + alert.
        fireEvent.click(screen.getByLabelText('Change Find in history'));
        const capture = screen.getByLabelText(
            'Recording chord for Find in history',
        );
        fireEvent.keyDown(capture, { key: 'k', ctrlKey: true });
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(
            (
                screen.getByRole('button', {
                    name: 'Save shortcuts',
                }) as HTMLButtonElement
            ).disabled,
        ).toBe(true);
    });

    test('App tab: clearing a shortcut then saving persists overrides', async () => {
        const api = makeApi();
        renderDialog(api);
        open();
        fireEvent.click(screen.getByRole('tab', { name: 'App settings' }));
        await screen.findByLabelText('Clear Find in history');
        // Let the app-settings query resolve so the working-copy seed effect runs FIRST
        // (otherwise a late load would clobber the edit below).
        await waitFor(() => expect(api.appSettingsGet).toHaveBeenCalled());
        await act(async () => {
            await Promise.resolve();
        });
        fireEvent.click(screen.getByLabelText('Clear Find in history'));
        fireEvent.click(screen.getByRole('button', { name: 'Save shortcuts' }));
        await waitFor(() => {
            expect(api.appSettingsSet).toHaveBeenCalled();
        });
        const lastCall = (
            api.appSettingsSet as ReturnType<typeof vi.fn>
        ).mock.calls.at(-1)?.[0] as { keybindings: KeyBinding[] };
        expect(
            lastCall.keybindings.some(
                b => b.commandId === 'history.find' && b.chord === '',
            ),
        ).toBe(true);
    });

    test('recording a chord does not also fire the global action it is bound to', async () => {
        const palette = vi.fn();
        const qc = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        const Wrap = () => {
            useKeybindings({ 'view.commandPalette': palette });
            return <SettingsDialog />;
        };
        render(
            <QueryClientProvider client={qc}>
                <ApiProvider api={makeApi()}>
                    <Wrap />
                </ApiProvider>
            </QueryClientProvider>,
        );
        open();
        fireEvent.click(screen.getByRole('tab', { name: 'App settings' }));
        fireEvent.click(
            await screen.findByLabelText('Change Open command palette'),
        );
        const capture = screen.getByLabelText(
            'Recording chord for Open command palette',
        );
        // The window dispatcher also sees this bubbled keydown; while capturing it must stand
        // down so Mod+K records the chord instead of opening the palette over Settings.
        fireEvent.keyDown(capture, { key: 'k', ctrlKey: true });
        expect(palette).not.toHaveBeenCalled();

        // Capture over → the dispatcher resumes and the same chord fires its action.
        await act(async () => {
            await Promise.resolve();
        });
        act(() => {
            window.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }),
            );
        });
        expect(palette).toHaveBeenCalledTimes(1);
    });

    test('guided editor prefills the worktree value over the repo-local one (git precedence)', async () => {
        const api = makeApi({
            configList: vi.fn(async () => [
                {
                    key: 'core.editor',
                    value: 'vim',
                    scope: 'local',
                    origin: 'file:.git/config',
                },
                {
                    key: 'core.editor',
                    value: 'nano',
                    scope: 'worktree',
                    origin: 'file:.git/config.worktree',
                },
            ]),
        });
        renderDialog(api);
        open();
        const editor = (await screen.findByLabelText(
            'core.editor',
        )) as HTMLInputElement;
        await waitFor(() => expect(editor.value).toBe('nano'));
    });

    test('guided Credentials surfaces an actionable message when a multivar set fails', async () => {
        const api = makeApi({
            configSet: vi.fn(async () => {
                throw new Error('boom');
            }),
        });
        renderDialog(api);
        open();
        const helper = (await screen.findByLabelText(
            'credential.helper',
        )) as HTMLInputElement;
        fireEvent.change(helper, { target: { value: 'store' } });
        fireEvent.click(helper.parentElement!.querySelector('button')!);
        await waitFor(() => expect(toast.error).toHaveBeenCalled());
        const msg = (toast.error as ReturnType<typeof vi.fn>).mock.calls.at(
            -1,
        )?.[0] as string;
        expect(msg).toMatch(/multiple values/i);
        expect(msg).toContain('credential.helper');
    });
});
