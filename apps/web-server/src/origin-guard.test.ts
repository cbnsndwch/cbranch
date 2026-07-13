import { describe, expect, test } from 'vitest';

import { TAURI_DESKTOP_ORIGINS } from './config';
import { isAllowedRequest } from './origin-guard';

const allow = new Set(['127.0.0.1', 'localhost', '::1']);
const desktopOrigins = new Set(TAURI_DESKTOP_ORIGINS);

describe('isAllowedRequest (NF-SEC-3)', () => {
    test('allows an allowlisted Host with no Origin (same-origin GET / Node WS client)', () => {
        expect(isAllowedRequest({ host: '127.0.0.1:7420' }, allow)).toBe(true);
    });

    test('allows a matching Host + Origin', () => {
        expect(
            isAllowedRequest(
                { host: 'localhost:7420', origin: 'http://localhost:7420' },
                allow,
            ),
        ).toBe(true);
    });

    test('rejects a missing Host', () => {
        expect(isAllowedRequest({}, allow)).toBe(false);
    });

    test('rejects a foreign Host', () => {
        expect(isAllowedRequest({ host: 'evil.example.com' }, allow)).toBe(
            false,
        );
    });

    test('rejects a foreign Origin even with an allowed Host (DNS rebinding)', () => {
        expect(
            isAllowedRequest(
                { host: '127.0.0.1:7420', origin: 'http://evil.example.com' },
                allow,
            ),
        ).toBe(false);
    });

    test('rejects a custom scheme without an exact desktop-origin allowlist entry', () => {
        expect(
            isAllowedRequest(
                { host: '127.0.0.1:7420', origin: 'tauri://localhost' },
                allow,
            ),
        ).toBe(false);
    });

    test('rejects a malformed Origin', () => {
        expect(
            isAllowedRequest(
                { host: '127.0.0.1:7420', origin: 'http://' },
                allow,
            ),
        ).toBe(false);
    });

    test.each(TAURI_DESKTOP_ORIGINS)(
        'allows the exact Tauri origin %s only on an allowlisted loopback Host',
        origin => {
            expect(
                isAllowedRequest(
                    { host: '127.0.0.1:7420', origin },
                    allow,
                    desktopOrigins,
                ),
            ).toBe(true);
        },
    );

    test.each([
        'https://tauri.localhost',
        'http://evil.tauri.localhost',
        'tauri://evil.localhost',
        'null',
    ])('rejects a non-exact desktop Origin: %s', origin => {
        expect(
            isAllowedRequest(
                { host: '127.0.0.1:7420', origin },
                allow,
                desktopOrigins,
            ),
        ).toBe(false);
    });

    test('handles a bracketed IPv6 Host', () => {
        expect(isAllowedRequest({ host: '[::1]:7420' }, allow)).toBe(true);
    });
});
