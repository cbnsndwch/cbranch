const MD5_SHIFTS = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
    9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
    16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10,
    15, 21,
];

const rotateLeft = (value: number, bits: number): number =>
    (value << bits) | (value >>> (32 - bits));

// Gravatar identifies emails by their MD5 digest. This stays local rather than sending an
// extra request before the image load.
export const md5 = (value: string): string => {
    const bytes = new TextEncoder().encode(value);
    const words = new Uint32Array((((bytes.length + 8) >>> 6) + 1) * 16);
    for (let index = 0; index < bytes.length; index++)
        words[index >>> 2] |= bytes[index]! << ((index % 4) * 8);
    words[bytes.length >>> 2] |= 0x80 << ((bytes.length % 4) * 8);
    words[words.length - 2] = bytes.length * 8;

    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;
    for (let offset = 0; offset < words.length; offset += 16) {
        let a = a0;
        let b = b0;
        let c = c0;
        let d = d0;
        for (let index = 0; index < 64; index++) {
            const [f, g] =
                index < 16
                    ? [(b & c) | (~b & d), index]
                    : index < 32
                      ? [(d & b) | (~d & c), (5 * index + 1) % 16]
                      : index < 48
                        ? [b ^ c ^ d, (3 * index + 5) % 16]
                        : [c ^ (b | ~d), (7 * index) % 16];
            const constant = Math.floor(
                Math.abs(Math.sin(index + 1)) * 2 ** 32,
            );
            const next =
                (b +
                    rotateLeft(
                        a + f + constant + words[offset + g]!,
                        MD5_SHIFTS[index]!,
                    )) >>>
                0;
            a = d;
            d = c;
            c = b;
            b = next;
        }
        a0 = (a0 + a) >>> 0;
        b0 = (b0 + b) >>> 0;
        c0 = (c0 + c) >>> 0;
        d0 = (d0 + d) >>> 0;
    }

    return [a0, b0, c0, d0]
        .map(word =>
            [...Array(4)]
                .map((_, index) =>
                    ((word >>> (index * 8)) & 0xff)
                        .toString(16)
                        .padStart(2, '0'),
                )
                .join(''),
        )
        .join('');
};

/** Image sources in fallback order for a commit identity. */
export const commitAvatarUrls = (
    name: string,
    email: string,
): ReadonlyArray<string> => {
    const emailKey = email.trim().toLowerCase();
    const githubEmail = emailKey
        ? `https://github.com/${encodeURIComponent(emailKey)}.png?size=44`
        : undefined;
    const githubUsername = name.trim()
        ? `https://github.com/${encodeURIComponent(name.trim())}.png?size=44`
        : undefined;
    const gravatar = emailKey
        ? `https://www.gravatar.com/avatar/${md5(emailKey)}?s=44&d=404`
        : undefined;
    return [githubEmail, githubUsername, gravatar].filter(
        (url): url is string => url !== undefined,
    );
};
