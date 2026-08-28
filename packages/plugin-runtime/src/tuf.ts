import { PluginCatalogEntry } from '@cbranch/plugin-contract';

import { PluginPolicyError } from './policy';

export type TufKey = {
    readonly keyType: 'ed25519';
    readonly keyValue: string;
};

export type TufSignatureVerifier = (
    key: TufKey,
    canonicalSigned: Uint8Array,
    signature: string,
) => Promise<boolean>;

type TufEnvelope = {
    readonly signed: Record<string, unknown>;
    readonly signatures: readonly {
        readonly keyid: string;
        readonly sig: string;
    }[];
};

type TufRole = {
    readonly keyids: readonly string[];
    readonly threshold: number;
};

export type TufRepositoryMetadata = {
    readonly root: Uint8Array;
    readonly timestamp: Uint8Array;
    readonly snapshot: Uint8Array;
    readonly targets: Uint8Array;
};

export type VerifiedTufCatalog = {
    readonly entries: readonly PluginCatalogEntry[];
    readonly targetsVersion: number;
    readonly expiresAt: number;
};

/** Verify the root/timestamp/snapshot/targets chain and decode signed plugin targets. */
export const verifyTufCatalog = async (
    metadata: TufRepositoryMetadata,
    verifySignature: TufSignatureVerifier,
    now = Date.now(),
): Promise<VerifiedTufCatalog> => {
    const root = parseEnvelope(metadata.root, 'root');
    const rootSigned = object(root.signed, 'root signed metadata');
    validateRoleType(rootSigned, 'root');
    const keys = object(rootSigned.keys, 'root keys');
    const roles = object(rootSigned.roles, 'root roles');
    await verifyRole(root, role(roles, 'root'), keys, verifySignature);
    const rootExpiresAt = validateVersionAndExpiry(rootSigned, 'root', now);

    const timestamp = parseEnvelope(metadata.timestamp, 'timestamp');
    await verifyRole(
        timestamp,
        role(roles, 'timestamp'),
        keys,
        verifySignature,
    );
    const timestampSigned = object(
        timestamp.signed,
        'timestamp signed metadata',
    );
    validateRoleType(timestampSigned, 'timestamp');
    const timestampExpiresAt = validateVersionAndExpiry(
        timestampSigned,
        'timestamp',
        now,
    );
    const snapshotVersion = await verifyMeta(
        metadata.snapshot,
        object(timestampSigned.meta, 'timestamp metadata')['snapshot.json'],
    );

    const snapshot = parseEnvelope(metadata.snapshot, 'snapshot');
    await verifyRole(snapshot, role(roles, 'snapshot'), keys, verifySignature);
    const snapshotSigned = object(snapshot.signed, 'snapshot signed metadata');
    validateRoleType(snapshotSigned, 'snapshot');
    const snapshotExpiresAt = validateVersionAndExpiry(
        snapshotSigned,
        'snapshot',
        now,
    );
    if (snapshotSigned.version !== snapshotVersion) {
        throw invalid('Plugin repository snapshot version does not match.');
    }
    const targetsVersion = await verifyMeta(
        metadata.targets,
        object(snapshotSigned.meta, 'snapshot metadata')['targets.json'],
    );

    const targets = parseEnvelope(metadata.targets, 'targets');
    await verifyRole(targets, role(roles, 'targets'), keys, verifySignature);
    const targetsSigned = object(targets.signed, 'targets signed metadata');
    validateRoleType(targetsSigned, 'targets');
    const targetsExpiresAt = validateVersionAndExpiry(
        targetsSigned,
        'targets',
        now,
    );
    if (targetsSigned.version !== targetsVersion) {
        throw invalid('Plugin repository targets version does not match.');
    }
    return {
        entries: decodeCatalog(
            object(targetsSigned.targets, 'targets metadata'),
        ),
        targetsVersion: number(targetsSigned.version, 'targets version'),
        expiresAt: Math.min(
            rootExpiresAt,
            timestampExpiresAt,
            snapshotExpiresAt,
            targetsExpiresAt,
        ),
    };
};

const parseEnvelope = (bytes: Uint8Array, roleName: string): TufEnvelope => {
    let value: unknown;
    try {
        value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        throw invalid(`Plugin repository ${roleName} metadata is not JSON.`);
    }
    const envelope = object(value, `${roleName} metadata`);
    const signed = object(envelope.signed, `${roleName} signed metadata`);
    const signatures = array(envelope.signatures, `${roleName} signatures`).map(
        signature => {
            const signatureValue = object(signature, `${roleName} signature`);
            return {
                keyid: string(
                    signatureValue.keyid,
                    `${roleName} signature key id`,
                ),
                sig: string(signatureValue.sig, `${roleName} signature`),
            };
        },
    );
    return { signed, signatures };
};

const verifyRole = async (
    envelope: TufEnvelope,
    roleDefinition: TufRole,
    keys: Record<string, unknown>,
    verifySignature: TufSignatureVerifier,
): Promise<void> => {
    const signed = new TextEncoder().encode(canonicalJson(envelope.signed));
    const candidates = roleDefinition.keyids.map(keyId => ({
        keyId,
        signatures: envelope.signatures.filter(
            signature => signature.keyid === keyId,
        ),
    }));
    const results = await Promise.all(
        candidates.map(async candidate =>
            (
                await Promise.all(
                    candidate.signatures.map(signature =>
                        verifySignature(
                            decodeKey(keys[candidate.keyId]),
                            signed,
                            signature.sig,
                        ),
                    ),
                )
            ).some(Boolean),
        ),
    );
    const valid = results.filter(Boolean).length;
    if (valid < roleDefinition.threshold) {
        throw invalid(
            'Plugin repository metadata signature threshold was not met.',
        );
    }
};

const verifyMeta = async (
    bytes: Uint8Array,
    metadata: unknown,
): Promise<number> => {
    const target = object(metadata, 'repository metadata reference');
    const version = positiveInteger(
        target.version,
        'repository metadata version',
    );
    const length = number(target.length, 'repository metadata length');
    const sha256 = string(
        object(target.hashes, 'repository metadata hashes').sha256,
        'repository metadata sha256',
    );
    const actual = new Uint8Array(
        await globalThis.crypto.subtle.digest(
            'SHA-256',
            bytes as unknown as BufferSource,
        ),
    );
    const digest = Array.from(actual, byte =>
        byte.toString(16).padStart(2, '0'),
    ).join('');
    if (length !== bytes.byteLength || sha256 !== digest) {
        throw invalid('Plugin repository metadata digest does not match.');
    }
    return version;
};

const decodeCatalog = (
    targets: Record<string, unknown>,
): readonly PluginCatalogEntry[] => {
    const entries = Object.entries(targets);
    if (entries.length > 1_000) {
        throw invalid('Plugin repository catalog has too many targets.');
    }
    return entries.map(([artifactPath, target]) => {
        const value = object(target, 'plugin target');
        const custom = object(value.custom, 'plugin target custom metadata');
        const hashes = object(value.hashes, 'plugin target hashes');
        return new PluginCatalogEntry({
            pluginId: string(
                custom.pluginId,
                'plugin id',
            ) as PluginCatalogEntry['pluginId'],
            version: boundedString(custom.version, 'plugin version', 128),
            publisherFingerprint: boundedString(
                custom.publisherFingerprint,
                'publisher fingerprint',
                128,
            ),
            artifactPath: boundedString(artifactPath, 'artifact path', 1_024),
            artifactSha256: `sha256:${string(hashes.sha256, 'artifact sha256')}`,
            artifactLength: number(value.length, 'artifact length'),
            minimumCbranchVersion: boundedString(
                custom.minimumCbranchVersion,
                'minimum cbranch version',
                128,
            ),
            pluginContractVersion: number(
                custom.pluginContractVersion,
                'plugin contract version',
            ),
            capabilityDigest: boundedString(
                custom.capabilityDigest,
                'capability digest',
                128,
            ),
            releaseNotes: boundedString(
                custom.releaseNotes,
                'release notes',
                16_384,
            ),
            advisoryIds: boundedArray(
                custom.advisoryIds,
                'advisory ids',
                100,
            ).map(advisory => boundedString(advisory, 'advisory id', 128)),
        });
    });
};

const role = (roles: Record<string, unknown>, name: string): TufRole => {
    const roleValue = object(roles[name], `${name} role`);
    const keyids = array(roleValue.keyids, `${name} key ids`).map(keyId =>
        string(keyId, `${name} key id`),
    );
    const threshold = positiveInteger(roleValue.threshold, `${name} threshold`);
    if (
        keyids.length === 0 ||
        new Set(keyids).size !== keyids.length ||
        threshold > keyids.length
    ) {
        throw invalid(`Plugin repository ${name} role is malformed.`);
    }
    return {
        keyids,
        threshold,
    };
};

const decodeKey = (value: unknown): TufKey => {
    const key = object(value, 'TUF key');
    const keyValue = string(
        object(key.keyval, 'TUF key value').public,
        'TUF key',
    );
    if (key.keytype !== 'ed25519' || !/^[0-9a-f]{64}$/.test(keyValue)) {
        throw invalid('Plugin repository uses an unsupported signing key.');
    }
    return { keyType: 'ed25519', keyValue };
};

const validateVersionAndExpiry = (
    signed: Record<string, unknown>,
    roleName: string,
    now: number,
): number => {
    positiveInteger(signed.version, `${roleName} version`);
    const expiry = Date.parse(string(signed.expires, `${roleName} expiry`));
    if (!Number.isFinite(expiry) || expiry <= now) {
        throw new PluginPolicyError(
            'pluginMetadataExpired',
            `Plugin repository ${roleName} metadata has expired.`,
        );
    }
    return expiry;
};

const validateRoleType = (
    signed: Record<string, unknown>,
    roleName: string,
): void => {
    if (signed._type !== roleName) {
        throw invalid(
            `Plugin repository ${roleName} metadata has an invalid role type.`,
        );
    }
};

const object = (value: unknown, label: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw invalid(`Plugin repository ${label} is malformed.`);
    return value as Record<string, unknown>;
};
const array = (value: unknown, label: string): readonly unknown[] => {
    if (!Array.isArray(value))
        throw invalid(`Plugin repository ${label} is malformed.`);
    return value;
};
const boundedArray = (
    value: unknown,
    label: string,
    maximumLength: number,
): readonly unknown[] => {
    const parsed = array(value, label);
    if (parsed.length > maximumLength) {
        throw invalid(`Plugin repository ${label} is too large.`);
    }
    return parsed;
};
const string = (value: unknown, label: string): string => {
    if (typeof value !== 'string')
        throw invalid(`Plugin repository ${label} is malformed.`);
    return value;
};
const boundedString = (
    value: unknown,
    label: string,
    maximumLength: number,
): string => {
    const parsed = string(value, label);
    if (parsed.length > maximumLength) {
        throw invalid(`Plugin repository ${label} is too large.`);
    }
    return parsed;
};
const number = (value: unknown, label: string): number => {
    if (typeof value !== 'number')
        throw invalid(`Plugin repository ${label} is malformed.`);
    return value;
};
const positiveInteger = (value: unknown, label: string): number => {
    const parsed = number(value, label);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw invalid(`Plugin repository ${label} is malformed.`);
    }
    return parsed;
};
const invalid = (message: string): PluginPolicyError =>
    new PluginPolicyError('pluginMetadataInvalid', message);

const canonicalJson = (value: unknown): string => {
    if (
        value === null ||
        typeof value === 'boolean' ||
        typeof value === 'string'
    )
        return JSON.stringify(value);
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw invalid('TUF metadata contains a non-finite number.');
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const objectValue = object(value, 'metadata');
    return `{${Object.keys(objectValue)
        .toSorted()
        .map(key => `${JSON.stringify(key)}:${canonicalJson(objectValue[key])}`)
        .join(',')}}`;
};
