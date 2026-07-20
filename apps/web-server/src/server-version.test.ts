import { describe, expect, test } from 'vitest';

import { serverVersion } from './server-version';

describe('serverVersion', () => {
    test('uses the release version injected by managed desktop packaging', () => {
        expect(serverVersion({ CBRANCH_RELEASE_VERSION: '0.2.2-rc.15' })).toBe(
            '0.2.2-rc.15',
        );
    });
});
