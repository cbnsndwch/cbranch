import { useEffect, useState } from 'react';
import { CBRANCH_PROTOCOL_VERSION } from '@cbranch/rpc-contract';

import { makeHostEndpoint, type HostEndpoint } from '../rpc/client';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import {
    type CbranchServerProbe,
    type ConnectionProfile,
    loadDesktopBridge,
    probeCbranchServer,
} from './bridge';

const emptyProfile = (): Omit<ConnectionProfile, 'id'> => ({
    name: '',
    host: '',
    user: '',
    sshPort: 22,
    remotePort: 7420,
});

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

export function ConnectionProfilesScreen({
    connectionError,
    onConnect,
    onRetry,
}: {
    readonly connectionError?: string;
    readonly onConnect: (endpoint: HostEndpoint) => void;
    readonly onRetry: () => void;
}) {
    const [profiles, setProfiles] = useState<ReadonlyArray<ConnectionProfile>>(
        [],
    );
    const [editing, setEditing] = useState<
        ConnectionProfile | Omit<ConnectionProfile, 'id'>
    >(emptyProfile());
    const [selectedId, setSelectedId] = useState<string>();
    const [notice, setNotice] = useState<string>();
    const [diagnostics, setDiagnostics] = useState<string>();
    const [serverProbe, setServerProbe] =
        useState<Exclude<CbranchServerProbe, { readonly status: 'ready' }>>();
    const [busy, setBusy] = useState(false);

    const reload = async () => {
        const next = await (await loadDesktopBridge()).listProfiles();
        setProfiles(next);
    };

    useEffect(() => {
        void reload().catch(error => setNotice(errorMessage(error)));
    }, []);

    const select = (profile: ConnectionProfile) => {
        setSelectedId(profile.id);
        setEditing(profile);
        setNotice(undefined);
        setServerProbe(undefined);
    };

    const save = async () => {
        setBusy(true);
        setNotice(undefined);
        try {
            const saved = await (
                await loadDesktopBridge()
            ).saveProfile(editing);
            await reload();
            select(saved);
            setNotice(
                'Profile saved. No SSH password, key, or token was stored.',
            );
        } catch (error) {
            setNotice(errorMessage(error));
        } finally {
            setBusy(false);
        }
    };

    const test = async () => {
        if (!selectedId) return;
        setBusy(true);
        try {
            setNotice(
                await (await loadDesktopBridge()).testProfile(selectedId),
            );
        } catch (error) {
            setNotice(errorMessage(error));
        } finally {
            setBusy(false);
        }
    };

    const connect = async () => {
        if (!selectedId) return;
        setBusy(true);
        setNotice(undefined);
        setServerProbe(undefined);
        try {
            const bridge = await loadDesktopBridge();
            const tunnel = await bridge.connectProfile(selectedId);
            const probe = await probeCbranchServer(tunnel.httpBaseUrl);
            if (probe.status !== 'ready') {
                try {
                    await bridge.disconnect();
                } finally {
                    setServerProbe(probe);
                }
                return;
            }
            onConnect(makeHostEndpoint(tunnel.rpcUrl, tunnel.httpBaseUrl));
        } catch (error) {
            setNotice(errorMessage(error));
        } finally {
            setBusy(false);
        }
    };

    const setupServer = async () => {
        if (!selectedId) return;
        setBusy(true);
        setNotice('Installing and starting cbranch on the remote host…');
        try {
            const bridge = await loadDesktopBridge();
            const setup = await bridge.setupProfile(selectedId);
            await reload();
            select(setup.profile);
            if (setup.warning) setNotice(setup.warning);

            const tunnel = await bridge.connectProfile(setup.profile.id);
            const probe = await probeCbranchServer(tunnel.httpBaseUrl);
            if (probe.status !== 'ready') {
                try {
                    await bridge.disconnect();
                } finally {
                    setServerProbe(probe);
                }
                return;
            }
            onConnect(makeHostEndpoint(tunnel.rpcUrl, tunnel.httpBaseUrl));
        } catch (error) {
            setNotice(errorMessage(error));
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (!selectedId || !confirm('Delete this connection profile?')) return;
        setBusy(true);
        try {
            await (await loadDesktopBridge()).deleteProfile(selectedId);
            setSelectedId(undefined);
            setEditing(emptyProfile());
            await reload();
        } catch (error) {
            setNotice(errorMessage(error));
        } finally {
            setBusy(false);
        }
    };

    const showDiagnostics = async () => {
        setBusy(true);
        try {
            const bridge = await loadDesktopBridge();
            const [details, command] = await Promise.all([
                bridge.diagnostics(),
                selectedId
                    ? bridge.diagnosticCommand(selectedId)
                    : Promise.resolve(undefined),
            ]);
            setDiagnostics(
                `${JSON.stringify(details, null, 2)}${
                    command ? `\n\nDiagnostic command:\n${command}` : ''
                }`,
            );
        } catch (error) {
            setNotice(errorMessage(error));
        } finally {
            setBusy(false);
        }
    };

    const update = <K extends keyof Omit<ConnectionProfile, 'id'>>(
        key: K,
        value: Omit<ConnectionProfile, 'id'>[K],
    ) => setEditing(current => ({ ...current, [key]: value }));

    const selectedProfile = profiles.find(profile => profile.id === selectedId);
    const serverPort = selectedProfile?.remotePort ?? editing.remotePort;
    const setupCommand = `pnpm install --frozen-lockfile
pnpm build
CBRANCH_BIND_ADDRESS=127.0.0.1 CBRANCH_PORT=${serverPort} pnpm --filter @cbranch/web-server start`;

    return (
        <main className="grid min-h-dvh place-items-center bg-muted/20 p-4">
            <section className="grid w-full max-w-4xl gap-0 border bg-background shadow-sm md:grid-cols-[220px_1fr]">
                <aside className="border-b bg-muted/30 p-4 md:border-r md:border-b-0">
                    <div className="flex items-center justify-between gap-2">
                        <h1 className="font-semibold">Connections</h1>
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => {
                                setSelectedId(undefined);
                                setEditing(emptyProfile());
                                setNotice(undefined);
                                setServerProbe(undefined);
                            }}
                        >
                            New
                        </Button>
                    </div>
                    <div className="mt-3 grid gap-1">
                        {profiles.map(profile => (
                            <button
                                key={profile.id}
                                type="button"
                                className="border px-2 py-2 text-left text-sm hover:bg-accent"
                                aria-pressed={selectedId === profile.id}
                                onClick={() => select(profile)}
                            >
                                <span className="block font-medium">
                                    {profile.name}
                                </span>
                                <span className="text-muted-foreground block truncate font-mono text-xs">
                                    {profile.user}@{profile.host}
                                </span>
                            </button>
                        ))}
                        {profiles.length === 0 && (
                            <p className="text-muted-foreground text-xs">
                                Create a profile to connect over SSH.
                            </p>
                        )}
                    </div>
                </aside>
                <div className="grid gap-4 p-5">
                    <div>
                        <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                            SSH local forward
                        </p>
                        <h2 className="mt-1 text-lg font-semibold">
                            {selectedId ? 'Edit connection' : 'New connection'}
                        </h2>
                        <p className="text-muted-foreground mt-1 text-sm">
                            cbranch uses your system OpenSSH client, agent,
                            keys, SSH config, and known_hosts file.
                        </p>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <label className="grid gap-1 text-sm">
                            Profile name
                            <Input
                                value={editing.name}
                                onChange={event =>
                                    update('name', event.target.value)
                                }
                            />
                        </label>
                        <label className="grid gap-1 text-sm">
                            SSH host
                            <Input
                                value={editing.host}
                                onChange={event =>
                                    update('host', event.target.value)
                                }
                                placeholder="server.example.com"
                            />
                        </label>
                        <label className="grid gap-1 text-sm">
                            SSH user
                            <Input
                                value={editing.user}
                                onChange={event =>
                                    update('user', event.target.value)
                                }
                                placeholder="serge"
                            />
                        </label>
                        <label className="grid gap-1 text-sm">
                            SSH port
                            <Input
                                type="number"
                                min="1"
                                max="65535"
                                value={editing.sshPort}
                                onChange={event =>
                                    update(
                                        'sshPort',
                                        Number(event.target.value),
                                    )
                                }
                            />
                        </label>
                        <label className="grid gap-1 text-sm sm:col-span-2">
                            Remote cbranch port
                            <Input
                                type="number"
                                min="1"
                                max="65535"
                                value={editing.remotePort}
                                onChange={event =>
                                    update(
                                        'remotePort',
                                        Number(event.target.value),
                                    )
                                }
                            />
                        </label>
                    </div>
                    {(notice || connectionError) && (
                        <p
                            role="alert"
                            className="border border-destructive/40 bg-destructive/10 p-2 text-sm"
                        >
                            {connectionError ?? notice}
                        </p>
                    )}
                    {serverProbe && (
                        <section className="grid gap-3 border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                            <div>
                                <h3 className="font-semibold">
                                    {serverProbe.status === 'missing'
                                        ? 'cbranch server not found'
                                        : 'cbranch server needs an update'}
                                </h3>
                                <p className="text-muted-foreground mt-1">
                                    {serverProbe.status === 'missing'
                                        ? `No cbranch server responded on ${selectedProfile?.host ?? editing.host}:127.0.0.1:${serverPort} through this SSH connection.`
                                        : serverProbe.protocolVersion ===
                                            undefined
                                          ? 'The selected port responded, but it is not a compatible cbranch server.'
                                          : serverProbe.protocolVersion !==
                                              CBRANCH_PROTOCOL_VERSION
                                            ? `The server uses protocol v${serverProbe.protocolVersion}, which this desktop client cannot use.`
                                            : serverProbe.version === undefined
                                              ? 'The server does not report a release version. Update cbranch on the remote host.'
                                              : `Server v${serverProbe.version} is older than this desktop client. Update cbranch on the remote host.`}
                                </p>
                            </div>
                            {serverProbe.status === 'missing' && (
                                <div className="grid gap-2">
                                    <p>
                                        cbranch can install its bundled server
                                        and start a managed systemd user service
                                        over this SSH connection. Node 20+ is
                                        the only remote prerequisite.
                                    </p>
                                    <p className="text-muted-foreground text-xs">
                                        If port {serverPort} is occupied,
                                        cbranch selects an unused loopback port
                                        and updates this profile automatically.
                                    </p>
                                    <details className="text-muted-foreground text-xs">
                                        <summary className="cursor-pointer font-medium">
                                            Set up manually instead
                                        </summary>
                                        <p className="mt-2">
                                            From a cbranch checkout on the
                                            remote host, run:
                                        </p>
                                        <pre className="mt-2 overflow-x-auto border bg-background/80 p-3 font-mono text-xs">
                                            {setupCommand}
                                        </pre>
                                    </details>
                                </div>
                            )}
                        </section>
                    )}
                    <div className="flex flex-wrap gap-2">
                        <Button
                            type="button"
                            disabled={busy}
                            onClick={() => void save()}
                        >
                            {busy ? 'Working…' : 'Save profile'}
                        </Button>
                        {selectedId && (
                            <>
                                <Button
                                    type="button"
                                    variant="outline"
                                    disabled={busy}
                                    onClick={() => void test()}
                                >
                                    Test tunnel
                                </Button>
                                {serverProbe && (
                                    <Button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => void setupServer()}
                                    >
                                        {serverProbe.status === 'missing'
                                            ? 'Set up cbranch'
                                            : 'Update cbranch'}
                                    </Button>
                                )}
                                <Button
                                    type="button"
                                    variant="outline"
                                    disabled={busy}
                                    onClick={() => void connect()}
                                >
                                    {serverProbe
                                        ? 'Re-check and connect'
                                        : 'Connect'}
                                </Button>
                                <Button
                                    type="button"
                                    variant="destructive"
                                    disabled={busy}
                                    onClick={() => void remove()}
                                >
                                    Delete
                                </Button>
                            </>
                        )}
                        {connectionError && (
                            <Button
                                type="button"
                                variant="outline"
                                disabled={busy}
                                onClick={onRetry}
                            >
                                Retry backend
                            </Button>
                        )}
                        <Button
                            type="button"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void showDiagnostics()}
                        >
                            About and diagnostics
                        </Button>
                    </div>
                    {diagnostics && (
                        <label className="grid gap-1 text-xs">
                            Diagnostics (select to copy)
                            <textarea
                                readOnly
                                value={diagnostics}
                                className="min-h-32 w-full resize-y border bg-muted/20 p-2 font-mono text-xs"
                            />
                        </label>
                    )}
                </div>
            </section>
        </main>
    );
}
