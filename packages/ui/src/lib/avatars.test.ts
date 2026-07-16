import { describe, expect, test } from 'vitest';

import { commitAvatarUrls, md5 } from './avatars';

describe('commit avatars', () => {
    test('uses GitHub email and username before a hashed Gravatar fallback', () => {
        expect(commitAvatarUrls('octocat', 'OctoCat@Example.test')).toEqual([
            'https://github.com/octocat%40example.test.png?size=44',
            'https://github.com/octocat.png?size=44',
            'https://www.gravatar.com/avatar/2031c49f6ddaa0a0836d92bfc1cd872a?s=44&d=404',
        ]);
    });

    test('hashes UTF-8 email input correctly', () => {
        expect(md5('test@example.com')).toBe(
            '55502f40dc8b7c769880b10874abc9d0',
        );
    });
});
