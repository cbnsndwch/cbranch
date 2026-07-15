import { createPublicKey, verify } from 'node:crypto';

import type { TufSignatureVerifier } from '@cbranch/plugin-runtime';

// RFC 8410 SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 public key.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Node host adapter for TUF's Ed25519 signatures over canonical signed metadata. */
export const verifyTufEd25519Signature: TufSignatureVerifier = async (
    key,
    canonicalSigned,
    signature,
): Promise<boolean> => {
    if (
        key.keyType !== 'ed25519' ||
        !/^[0-9a-f]{64}$/.test(key.keyValue) ||
        !/^[0-9a-f]+$/.test(signature)
    ) {
        return false;
    }
    const publicKey = createPublicKey({
        key: Buffer.concat([
            ED25519_SPKI_PREFIX,
            Buffer.from(key.keyValue, 'hex'),
        ]),
        format: 'der',
        type: 'spki',
    });
    return verify(
        null,
        canonicalSigned,
        publicKey,
        Buffer.from(signature, 'hex'),
    );
};
