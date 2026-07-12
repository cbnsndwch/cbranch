// Owns the connection-scoped RPC runtime and React Query cache. Replacing an
// endpoint always unmounts consumers, clears the old cache, and disposes its socket.

import { CBRANCH_PROTOCOL_VERSION } from '@cbranch/rpc-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
    createContext,
    type PropsWithChildren,
    useContext,
    useEffect,
    useMemo,
    useState,
} from 'react';

import { useUiStore } from '../state/store';
import { ConnectionErrorBoundary } from '../components/ConnectionErrorBoundary';
import { makeApi } from './api';
import { ApiProvider } from './ApiProvider';
import {
    defaultHostEndpoint,
    makeAppRuntime,
    type HostEndpoint,
    withClient,
} from './client';
import {
    transitionConnection,
    type ConnectionStatus,
} from './connection-state';

export type { ConnectionStatus } from './connection-state';

interface ConnectionContextValue {
    readonly endpoint: HostEndpoint | undefined;
    readonly status: ConnectionStatus;
    readonly error: string | undefined;
    readonly connect: (endpoint: HostEndpoint) => void;
    readonly retry: () => void;
    readonly disconnect: () => void;
    readonly markReconnecting: () => void;
    readonly markReconnected: () => void;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

const newQueryClient = () =>
    new QueryClient({
        defaultOptions: {
            queries: {
                staleTime: 30_000,
                retry: false,
                refetchOnWindowFocus: true,
            },
        },
    });

const resetUiSelection = () => {
    const store = useUiStore.getState();
    store.setActiveRepoId(null);
    store.setActiveEngagementId(null);
    store.setSelectedOid(null);
};

const errorMessage = (error: unknown): string => {
    if (error instanceof Error && error.message !== '') return error.message;
    return 'Could not connect to the cbranch backend.';
};

const compatibilityError = (info: { protocolVersion: number }): Error =>
    new Error(
        `The backend protocol is v${info.protocolVersion}, but this client requires v${CBRANCH_PROTOCOL_VERSION}. Update cbranch on the server or desktop client.`,
    );

/** Access the current connection lifecycle and selected host endpoint. */
export const useConnection = (): ConnectionContextValue => {
    const value = useContext(ConnectionContext);
    if (value === null)
        throw new Error('useConnection must be used within ConnectionProvider');
    return value;
};

/** Read connection state when the caller can also run in an isolated provider test. */
export const useOptionalConnection = (): ConnectionContextValue | null =>
    useContext(ConnectionContext);

/** Resolve backend-relative HTTP side-channel URLs for the active connection. */
export const useHostEndpoint = (): HostEndpoint => {
    const connection = useContext(ConnectionContext);
    const endpoint = connection?.endpoint;
    if (endpoint !== undefined) return endpoint;
    // Isolated component tests may provide only ApiProvider. Keep their browser-style
    // relative behavior while production gates side-channel consumers on a connection.
    if (typeof window !== 'undefined')
        return defaultHostEndpoint(window.location);
    throw new Error(
        'A host endpoint is required before using side-channel URLs.',
    );
};

export function ConnectionProvider({
    initialEndpoint,
    children,
}: PropsWithChildren<{ readonly initialEndpoint?: HostEndpoint }>) {
    const [endpoint, setEndpoint] = useState(initialEndpoint);
    const [attempt, setAttempt] = useState(0);
    const [status, setStatus] = useState<ConnectionStatus>(
        initialEndpoint === undefined ? 'disconnected' : 'connecting',
    );
    const [error, setError] = useState<string>();

    const session = useMemo(() => {
        if (endpoint === undefined) return undefined;
        const runtime = makeAppRuntime(endpoint.rpcUrl);
        return {
            endpoint,
            runtime,
            api: makeApi(runtime),
            queryClient: newQueryClient(),
            id: `${endpoint.rpcUrl}:${attempt}`,
        };
    }, [attempt, endpoint]);

    useEffect(() => {
        if (session === undefined) return;
        let active = true;
        setStatus(current => transitionConnection(current, 'start'));
        setError(undefined);

        void session.runtime
            .runPromise(withClient(client => client.SystemInfo({})))
            .then(info => {
                if (info.protocolVersion !== CBRANCH_PROTOCOL_VERSION)
                    throw compatibilityError(info);
                if (active)
                    setStatus(current =>
                        transitionConnection(current, 'handshakeSucceeded'),
                    );
            })
            .catch(reason => {
                if (active) {
                    setError(errorMessage(reason));
                    setStatus(current =>
                        transitionConnection(current, 'failed'),
                    );
                }
            });

        return () => {
            active = false;
            void session.queryClient.cancelQueries();
            session.queryClient.clear();
            void session.runtime.dispose();
        };
    }, [session]);

    const value = useMemo<ConnectionContextValue>(
        () => ({
            endpoint,
            status,
            error,
            connect: next => {
                resetUiSelection();
                setError(undefined);
                setStatus(current => transitionConnection(current, 'start'));
                setAttempt(0);
                setEndpoint(next);
            },
            retry: () => {
                if (endpoint === undefined) return;
                setError(undefined);
                setStatus(current => transitionConnection(current, 'start'));
                setAttempt(current => current + 1);
            },
            disconnect: () => {
                resetUiSelection();
                setEndpoint(undefined);
                setError(undefined);
                setStatus(current =>
                    transitionConnection(current, 'disconnect'),
                );
            },
            markReconnecting: () => {
                setStatus(current =>
                    transitionConnection(current, 'transportLost'),
                );
            },
            markReconnected: () => {
                setStatus(current =>
                    transitionConnection(current, 'transportRestored'),
                );
            },
        }),
        [endpoint, error, status],
    );

    const liveChildren =
        session !== undefined &&
        (status === 'connected' || status === 'reconnecting') ? (
            <QueryClientProvider key={session.id} client={session.queryClient}>
                <ApiProvider api={session.api}>
                    <ConnectionErrorBoundary
                        endpoint={session.endpoint.rpcUrl}
                        onRetry={() => {
                            setError(undefined);
                            setStatus(current =>
                                transitionConnection(current, 'start'),
                            );
                            setAttempt(current => current + 1);
                        }}
                    >
                        {children}
                    </ConnectionErrorBoundary>
                </ApiProvider>
            </QueryClientProvider>
        ) : (
            children
        );

    return (
        <ConnectionContext.Provider value={value}>
            {liveChildren}
        </ConnectionContext.Provider>
    );
}
