import { execFileSync } from 'node:child_process';
import {
    createHash,
    createPrivateKey,
    createPublicKey,
    sign,
} from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const privatePem = process.env.PLUGIN_TUF_PRIVATE_KEY?.replaceAll('\\n', '\n');
const output = process.env.PLUGIN_REGISTRY_DIRECTORY;
if (!privatePem || !output)
    throw new Error(
        'Set PLUGIN_TUF_PRIVATE_KEY and PLUGIN_REGISTRY_DIRECTORY.',
    );
const privateKey = createPrivateKey(privatePem);
const publicHex = Buffer.from(
    createPublicKey(privateKey).export({ format: 'jwk' }).x,
    'base64url',
).toString('hex');
const keyId = sha256(publicHex);
const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
const canonical = value =>
    value === null || typeof value !== 'object'
        ? JSON.stringify(value)
        : Array.isArray(value)
          ? `[${value.map(canonical).join(',')}]`
          : `{${Object.keys(value)
                .sort()
                .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
                .join(',')}}`;
const envelope = signed => ({
    signed,
    signatures: [
        {
            keyid: keyId,
            sig: sign(
                null,
                Buffer.from(canonical(signed)),
                privateKey,
            ).toString('hex'),
        },
    ],
});
const bytes = value => Buffer.from(`${JSON.stringify(value)}\n`);
const meta = value => ({
    length: value.length,
    hashes: { sha256: sha256(value) },
});
const rootPath = resolve(output, 'metadata/root.json');
let root;
try {
    root = await readFile(rootPath);
} catch (error) {
    if (!(error && typeof error === 'object' && error.code === 'ENOENT'))
        throw error;
    root = bytes(
        envelope({
            _type: 'root',
            version: 1,
            expires,
            keys: {
                [keyId]: { keytype: 'ed25519', keyval: { public: publicHex } },
            },
            roles: Object.fromEntries(
                ['root', 'timestamp', 'snapshot', 'targets'].map(role => [
                    role,
                    { keyids: [keyId], threshold: 1 },
                ]),
            ),
        }),
    );
}
const fingerprint = `sha256:${sha256(root)}`;
execFileSync('pnpm', ['--filter', '@cbranch/plugin-hello-world', 'package'], {
    stdio: 'inherit',
    env: { ...process.env, PLUGIN_PUBLISHER_FINGERPRINT: fingerprint },
});
const artifactName = 'dev.cbranch.hello-world.cbranch-plugin';
const artifact = await readFile(
    join('plugins', 'hello-world', 'artifacts', artifactName),
);
const targets = bytes(
    envelope({
        _type: 'targets',
        version: 1,
        expires,
        targets: {
            [`targets/${artifactName}`]: {
                ...meta(artifact),
                custom: {
                    pluginId: 'dev.cbranch.hello-world',
                    version: '0.1.0',
                    publisherFingerprint: fingerprint,
                    minimumCbranchVersion: '0.2.1',
                    pluginContractVersion: 1,
                    capabilityDigest: `sha256:${sha256('[]')}`,
                    releaseNotes: 'Hello World test plugin.',
                    advisoryIds: [],
                },
            },
        },
    }),
);
const snapshot = bytes(
    envelope({
        _type: 'snapshot',
        version: 1,
        expires,
        meta: { 'targets.json': meta(targets) },
    }),
);
const timestamp = bytes(
    envelope({
        _type: 'timestamp',
        version: 1,
        expires,
        meta: { 'snapshot.json': meta(snapshot) },
    }),
);
await mkdir(resolve(output, 'metadata'), { recursive: true });
await mkdir(resolve(output, 'targets'), { recursive: true });
await Promise.all([
    writeFile(resolve(output, 'metadata/root.json'), root),
    writeFile(resolve(output, 'metadata/targets.json'), targets),
    writeFile(resolve(output, 'metadata/snapshot.json'), snapshot),
    writeFile(resolve(output, 'metadata/timestamp.json'), timestamp),
    cp(
        join('plugins', 'hello-world', 'artifacts', artifactName),
        resolve(output, 'targets', artifactName),
    ),
]);
console.log(`Published TUF root fingerprint: ${fingerprint}`);
function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}
