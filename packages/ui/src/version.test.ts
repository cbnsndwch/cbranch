import { expect, test } from 'vitest';

import { version } from './version';

test('ui exposes a version', () => {
    expect(version).toBe('0.0.0');
});
