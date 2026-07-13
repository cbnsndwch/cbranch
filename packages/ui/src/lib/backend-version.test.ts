import { describe, expect, test } from 'vitest';

import { isBackendVersionCompatible } from './backend-version';

describe('isBackendVersionCompatible', () => {
    test('accepts the required version and newer same-major servers', () => {
        expect(isBackendVersionCompatible('0.1.3', '0.1.3')).toBe(true);
        expect(isBackendVersionCompatible('0.1.4', '0.1.3')).toBe(true);
        expect(isBackendVersionCompatible('0.2.0', '0.1.3')).toBe(true);
    });

    test('rejects old, malformed, and different-major servers', () => {
        expect(isBackendVersionCompatible('0.1.2', '0.1.3')).toBe(false);
        expect(isBackendVersionCompatible('1.0.0', '0.1.3')).toBe(false);
        expect(isBackendVersionCompatible('dev', '0.1.3')).toBe(false);
    });
});
