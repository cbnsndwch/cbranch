import { readFile } from 'node:fs/promises';

const tag = process.env.RELEASE_TAG;
if (!tag) throw new Error('RELEASE_TAG must contain the pushed release tag.');

const match = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(tag);
if (!match)
    throw new Error(
        `Invalid release tag "${tag}". Expected vMAJOR.MINOR.PATCH.`,
    );
const expectedVersion = tag.slice(1);

const [desktopPackage, tauriConfig, cargoToml, systemSchema] =
    await Promise.all([
        readFile('apps/tauri/package.json', 'utf8').then(JSON.parse),
        readFile('apps/tauri/src-tauri/tauri.conf.json', 'utf8').then(
            JSON.parse,
        ),
        readFile('apps/tauri/src-tauri/Cargo.toml', 'utf8'),
        readFile('packages/rpc-contract/src/schemas/system.ts', 'utf8'),
    ]);

const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(cargoToml)?.[1];
const backendVersion = /CBRANCH_BACKEND_VERSION\s*=\s*'([^']+)'/.exec(
    systemSchema,
)?.[1];
const versions = {
    'apps/tauri/package.json': desktopPackage.version,
    'apps/tauri/src-tauri/tauri.conf.json': tauriConfig.version,
    'apps/tauri/src-tauri/Cargo.toml': cargoVersion,
    'packages/rpc-contract/src/schemas/system.ts': backendVersion,
};

const mismatches = Object.entries(versions).filter(
    ([, version]) => version !== expectedVersion,
);
if (mismatches.length > 0) {
    const details = mismatches
        .map(([file, version]) => `${file} is ${String(version)}`)
        .join('; ');
    throw new Error(
        `Release tag ${tag} requires version ${expectedVersion}: ${details}.`,
    );
}

console.log(`Release ${tag} versions are consistent.`);
