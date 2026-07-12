// The shared UI never imports Tauri at module evaluation time. The desktop bundle
// loads this narrow command adapter only when its WebView runtime is present.

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

export interface DesktopBridge {
    listProfiles(): Promise<ReadonlyArray<ConnectionProfile>>;
    saveProfile(
        profile: Omit<ConnectionProfile, 'id'> & { id?: string },
    ): Promise<ConnectionProfile>;
    deleteProfile(id: string): Promise<void>;
    testProfile(id: string): Promise<string>;
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
        connectProfile: id => invoke('connect_profile', { id }),
        disconnect: () => invoke('disconnect_tunnel'),
        diagnosticCommand: id => invoke('diagnostic_command', { id }),
        diagnostics: () => invoke('desktop_diagnostics'),
    };
};
