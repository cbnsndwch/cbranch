import { generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { verifyTufEd25519Signature } from './tuf-signature-verifier';

describe('TUF Ed25519 signature verifier', () => {
    test('verifies a canonical metadata signature with a raw TUF public key', async () => {
        const { privateKey, publicKey } = generateKeyPairSync('ed25519');
        const der = publicKey.export({ format: 'der', type: 'spki' });
        const signed = new TextEncoder().encode('{"version":1}');
        const signature = sign(null, signed, privateKey).toString('hex');

        await expect(
            verifyTufEd25519Signature(
                {
                    keyType: 'ed25519',
                    keyValue: der.subarray(-32).toString('hex'),
                },
                signed,
                signature,
            ),
        ).resolves.toBe(true);
    });
});
