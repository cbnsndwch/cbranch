import { describe, expect, test } from 'vitest';

import { transitionConnection } from './connection-state';

describe('connection lifecycle', () => {
    test('covers initial connect, transport recovery, failure, and deliberate disconnect', () => {
        const connected = transitionConnection('disconnected', 'start');
        expect(connected).toBe('connecting');
        expect(transitionConnection(connected, 'handshakeSucceeded')).toBe(
            'connected',
        );
        expect(transitionConnection('connected', 'transportLost')).toBe(
            'reconnecting',
        );
        expect(transitionConnection('reconnecting', 'transportRestored')).toBe(
            'connected',
        );
        expect(transitionConnection('connecting', 'failed')).toBe('failed');
        expect(transitionConnection('failed', 'disconnect')).toBe(
            'disconnected',
        );
    });

    test('does not revive a deliberately disconnected connection', () => {
        expect(transitionConnection('disconnected', 'failed')).toBe(
            'disconnected',
        );
        expect(transitionConnection('disconnected', 'transportRestored')).toBe(
            'disconnected',
        );
    });
});
