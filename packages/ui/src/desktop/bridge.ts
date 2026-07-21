// The shared UI never imports Tauri at module evaluation time. The desktop bundle
// loads this narrow command adapter only when its WebView runtime is present.

import {
    CBRANCH_BACKEND_VERSION,
    CBRANCH_PROTOCOL_VERSION,
} from '@cbranch/rpc-contract';

import { isBackendVersionCompatible } from '../lib/backend-version';

export interface ConnectionProfile {
    readonly id: string;
    readonly name: string;
    readonly host: string;
    readonly user: string;
    readonly sshPort: number;
    readonly remotePort: number;
}

export interface TunnelConnection {
    readonly profileId: string;
    readonly rpcUrl: string;
    readonly httpBaseUrl: string;
}

export interface DesktopDiagnostics {
    readonly desktopVersion: string;
    readonly profile: ConnectionProfile | undefined;
    readonly tunnelState: string;
    readonly endpoint: string | undefined;
    readonly recentErrors: ReadonlyArray<string>;
}

export interface ManagedServerSetup {
    readonly profile: ConnectionProfile;
    readonly warning: string | undefined;
}

/** A Tailscale SSH check-mode sign-in URL emitted while a tunnel is connecting. */
export interface SshAuthChallenge {
    readonly profileId: string;
    readonly url: string;
}

export type CbranchServerProbe =
    | { readonly status: 'ready' }
    | { readonly status: 'missing' }
    | {
          readonly status: 'incompatible';
          readonly protocolVersion?: number;
          readonly version?: string;
      };

const isHealthResponse = (
    value: unknown,
): value is {
    readonly service: 'cbranch';
    readonly protocolVersion: number;
    readonly version?: string;
} =>
    typeof value === 'object' &&
    value !== null &&
    'service' in value &&
    value.service === 'cbranch' &&
    'protocolVersion' in value &&
    typeof value.protocolVersion === 'number';

const canaryVersion =
    import.meta.env.VITE_CBRANCH_CANARY === '1'
        ? import.meta.env.VITE_CBRANCH_VERSION?.replace(/^v/, '')
        : undefined;

/** Probe the remote service through the active SSH forward before starting RPC. */
export const probeCbranchServer = async (
    httpBaseUrl: string,
    request: typeof fetch = fetch,
): Promise<CbranchServerProbe> => {
    let response: Response;
    try {
        response = await request(new URL('/healthz', httpBaseUrl), {
            cache: 'no-store',
        });
    } catch {
        return { status: 'missing' };
    }
    if (!response.ok) return { status: 'incompatible' };

    let body: unknown;
    try {
        body = await response.json();
    } catch {
        return { status: 'incompatible' };
    }
    if (!isHealthResponse(body)) return { status: 'incompatible' };
    if (canaryVersion) {
        if (body.version !== canaryVersion)
            return {
                status: 'incompatible',
                protocolVersion: body.protocolVersion,
                version: body.version,
            };
    }
    if (body.protocolVersion !== CBRANCH_PROTOCOL_VERSION)
        return {
            status: 'incompatible',
            protocolVersion: body.protocolVersion,
            version: body.version,
        };
    if (
        !canaryVersion &&
        (typeof body.version !== 'string' ||
            !isBackendVersionCompatible(body.version, CBRANCH_BACKEND_VERSION))
    )
        return {
            status: 'incompatible',
            protocolVersion: body.protocolVersion,
            version: body.version,
        };
    return { status: 'ready' };
};

export interface DesktopBridge {
    listProfiles(): Promise<ReadonlyArray<ConnectionProfile>>;
    saveProfile(
        profile: Omit<ConnectionProfile, 'id'> & { id?: string },
    ): Promise<ConnectionProfile>;
    deleteProfile(id: string): Promise<void>;
    testProfile(id: string): Promise<string>;
    setupProfile(id: string): Promise<ManagedServerSetup>;
    connectProfile(id: string): Promise<TunnelConnection>;
    disconnect(): Promise<void>;
    diagnosticCommand(id: string): Promise<string>;
    diagnostics(): Promise<DesktopDiagnostics>;
}

declare global {
    interface Window {
        __TAURI_INTERNALS__?: unknown;
    }
}

export const isDesktopSurface = (): boolean =>
    typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined;

export const loadDesktopBridge = async (): Promise<DesktopBridge> => {
    if (!isDesktopSurface())
        throw new Error('The Tauri desktop bridge is unavailable.');
    const { invoke } = await import('@tauri-apps/api/core');
    return {
        listProfiles: () => invoke('list_profiles'),
        saveProfile: profile => invoke('save_profile', { profile }),
        deleteProfile: id => invoke('delete_profile', { id }),
        testProfile: id => invoke('test_profile', { id }),
        setupProfile: id => invoke('setup_profile', { id }),
        connectProfile: id => invoke('connect_profile', { id }),
        disconnect: () => invoke('disconnect_tunnel'),
        diagnosticCommand: id => invoke('diagnostic_command', { id }),
        diagnostics: () => invoke('desktop_diagnostics'),
    };
};

/** Listen for a Tailscale SSH browser challenge without exposing SSH credentials. */
export const listenForSshAuthChallenge = async (
    onChallenge: (challenge: SshAuthChallenge) => void,
): Promise<() => void> => {
    if (!isDesktopSurface()) return () => undefined;
    const { listen } = await import('@tauri-apps/api/event');
    return listen<SshAuthChallenge>('cbranch://ssh-auth-challenge', event =>
        onChallenge(event.payload),
    );
};

/** Set the native title only when the UI is running inside a Tauri WebView. */
export const setDesktopWindowTitle = async (title: string): Promise<void> => {
    if (!isDesktopSurface()) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().setTitle(title);
};
