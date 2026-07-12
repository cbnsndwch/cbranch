export type ConnectionStatus =
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'disconnected'
    | 'failed';

export type ConnectionEvent =
    | 'start'
    | 'handshakeSucceeded'
    | 'transportLost'
    | 'transportRestored'
    | 'failed'
    | 'disconnect';

/** The legal visible connection transitions, shared by initial and retry paths. */
export const transitionConnection = (
    current: ConnectionStatus,
    event: ConnectionEvent,
): ConnectionStatus => {
    switch (event) {
        case 'start':
            return 'connecting';
        case 'handshakeSucceeded':
            return current === 'connecting' ? 'connected' : current;
        case 'transportLost':
            return current === 'connected' ? 'reconnecting' : current;
        case 'transportRestored':
            return current === 'reconnecting' ? 'connected' : current;
        case 'failed':
            return current === 'disconnected' ? current : 'failed';
        case 'disconnect':
            return 'disconnected';
    }
};
