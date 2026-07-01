import { RepoId as RepoIdBrand } from '@cbranch/rpc-contract';
import { describe, expect, test } from 'vitest';

import { looksBinary, sidechannelBlobUrl } from './content';

describe('looksBinary', () => {
    test('text is not binary', () => {
        expect(looksBinary(Buffer.from('hello\nworld\n', 'utf8'))).toBe(false);
    });
    test('a NUL byte ⇒ binary (ENC-003 heuristic)', () => {
        expect(looksBinary(Buffer.from([0x68, 0x00, 0x69]))).toBe(true);
    });
});

describe('sidechannelBlobUrl', () => {
    test('builds a relative, URL-encoded side-channel route (DECISIONS D4)', () => {
        const url = sidechannelBlobUrl(
            RepoIdBrand.make('r1'),
            'HEAD',
            'dir/a b.txt',
        );
        expect(url).toBe(
            '/sidechannel/blob?repoId=r1&rev=HEAD&path=dir%2Fa%20b.txt',
        );
    });
});
