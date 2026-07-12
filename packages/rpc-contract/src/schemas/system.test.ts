import { Schema } from 'effect';
import { describe, expect, test } from 'vitest';

import { CBRANCH_PROTOCOL_VERSION, SystemInfo } from './system';

describe('SystemInfo compatibility schema', () => {
    test('round-trips an additive capability response', () => {
        const value = new SystemInfo({
            version: '0.1.0',
            protocolVersion: CBRANCH_PROTOCOL_VERSION,
            capabilities: ['system-info', 'loopback-rpc-v1', 'side-channel-v1'],
        });
        const encoded = Schema.encodeUnknownSync(SystemInfo)(value);
        expect(Schema.decodeUnknownSync(SystemInfo)(encoded)).toEqual(value);
    });

    test('rejects unknown capabilities at the wire boundary', () => {
        expect(
            Schema.decodeUnknownExit(SystemInfo)({
                version: '0.1.0',
                protocolVersion: 1,
                capabilities: ['untyped-desktop-protocol'],
            })._tag,
        ).toBe('Failure');
    });
});
