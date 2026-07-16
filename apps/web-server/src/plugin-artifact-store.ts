// Host-private verified artifact staging and activation. It validates every archive
// entry before materializing the reviewed ESM module; it never imports or executes it.

import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
    access,
    chmod,
    mkdir,
    readFile,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as zlib from 'node:zlib';

import {
    PluginManifest,
    type PluginCatalogEntry,
    type PluginGrant,
} from '@cbranch/plugin-contract';
import {
    MAX_PLUGIN_ARCHIVE_COMPRESSED_BYTES,
    MAX_PLUGIN_ARCHIVE_EXTRACTED_BYTES,
    PluginPolicyError,
    isSafeArchiveEntry,
    validateGrant,
    validateArtifact,
    validateManifestTargetConsistency,
    validatePluginArchive,
} from '@cbranch/plugin-runtime';
import { Schema } from 'effect';

import { resolvePluginDataDirectory } from './plugin-lock-store';

export interface PluginArtifactStore {
    readonly stage: (
        target: Pick<
            PluginCatalogEntry,
            'pluginId' | 'version' | 'artifactLength' | 'artifactSha256'
        >,
        artifact: Uint8Array,
    ) => Promise<string>;
    readonly activate: (
        target: PluginCatalogEntry,
        grant: PluginGrant,
    ) => Promise<ActivatedPluginArtifact>;
    readonly remove: (pluginId: string) => Promise<void>;
}

export type ActivatedPluginArtifact = {
    readonly directory: string;
    readonly manifest: PluginManifest;
    readonly entrypoint: string;
};

export type PluginArtifactStoreOptions = {
    readonly dataDirectory?: string;
    readonly env?: NodeJS.ProcessEnv;
};

/** Stage one digest-verified artifact atomically, retaining artifacts by exact version. */
export const makePluginArtifactStore = (
    options: PluginArtifactStoreOptions = {},
): PluginArtifactStore => {
    const dataDirectory =
        options.dataDirectory ?? resolvePluginDataDirectory(options.env);

    return {
        stage: async (target, artifact) => {
            const pluginId = String(target.pluginId);
            if (
                !isSafePathComponent(pluginId) ||
                !isSafePathComponent(target.version)
            ) {
                throw new PluginPolicyError(
                    'pluginArtifactInvalid',
                    'Plugin target has an unsafe local storage path.',
                );
            }
            if (target.artifactLength > MAX_PLUGIN_ARCHIVE_COMPRESSED_BYTES) {
                throw new PluginPolicyError(
                    'pluginArtifactInvalid',
                    'Plugin artifact exceeds the compressed size limit.',
                );
            }
            const actualSha256 = `sha256:${createHash('sha256').update(artifact).digest('hex')}`;
            validateArtifact(target, artifact.byteLength, actualSha256);

            const directory = join(dataDirectory, 'artifacts', pluginId);
            const destination = join(
                directory,
                `${target.version}.cbranch-plugin`,
            );
            await mkdir(directory, { recursive: true, mode: 0o700 });
            await chmod(directory, 0o700);

            const temporary = join(
                directory,
                `.${target.version}.${randomUUID()}.tmp`,
            );
            try {
                await writeFile(temporary, artifact, {
                    mode: 0o600,
                    flag: 'wx',
                });
                await rename(temporary, destination);
                await chmod(destination, 0o600);
                return destination;
            } catch (error) {
                await rm(temporary, { force: true });
                throw error;
            }
        },
        activate: async (target, grant) => {
            const staged = join(
                dataDirectory,
                'artifacts',
                String(target.pluginId),
                `${target.version}.cbranch-plugin`,
            );
            const artifact = await readFile(staged);
            const actualSha256 = `sha256:${createHash('sha256').update(artifact).digest('hex')}`;
            validateArtifact(target, artifact.byteLength, actualSha256);
            const files = readPluginArchive(
                await decompressZstd(artifact),
                artifact.byteLength,
            );
            const manifest = Schema.decodeUnknownSync(PluginManifest)(
                JSON.parse(new TextDecoder().decode(files.get('plugin.json')!)),
            );
            await validateManifestTargetConsistency(manifest, target);
            validateGrant(manifest, grant);
            if (!files.has(manifest.entrypoint)) {
                throw invalidArchive(
                    'Plugin archive does not contain its entrypoint.',
                );
            }

            const digest = target.artifactSha256.slice('sha256:'.length);
            if (
                !isSafePathComponent(String(target.pluginId)) ||
                !isSafePathComponent(target.version) ||
                !/^[0-9a-f]{64}$/.test(digest)
            ) {
                throw invalidArchive(
                    'Plugin target has an unsafe activation path.',
                );
            }
            const directory = join(
                dataDirectory,
                'activated',
                String(target.pluginId),
                target.version,
                digest,
            );
            const entrypoint = join(directory, manifest.entrypoint);
            try {
                await access(directory);
                return { directory, manifest, entrypoint };
            } catch (error) {
                if (!isMissingError(error)) throw error;
            }

            const parent = dirname(directory);
            await mkdir(parent, { recursive: true, mode: 0o700 });
            await chmod(parent, 0o700);
            const temporary = join(parent, `.${digest}.${randomUUID()}.tmp`);
            try {
                await mkdir(temporary, { recursive: false, mode: 0o700 });
                await Promise.all(
                    [...files].map(async ([path, contents]) => {
                        const destination = join(temporary, path);
                        await mkdir(dirname(destination), {
                            recursive: true,
                            mode: 0o700,
                        });
                        await writeFile(destination, contents, { mode: 0o600 });
                    }),
                );
                // A plugin `.js` entrypoint must have ESM semantics even outside this repo.
                await writeFile(
                    join(temporary, 'package.json'),
                    '{"type":"module"}\n',
                    { mode: 0o600 },
                );
                await rename(temporary, directory);
                return { directory, manifest, entrypoint };
            } catch (error) {
                await rm(temporary, { recursive: true, force: true });
                throw error;
            }
        },
        remove: async pluginId => {
            if (!isSafePathComponent(pluginId)) {
                throw new PluginPolicyError(
                    'pluginArtifactInvalid',
                    'Plugin target has an unsafe local storage path.',
                );
            }
            await Promise.all([
                rm(join(dataDirectory, 'artifacts', pluginId), {
                    recursive: true,
                    force: true,
                }),
                rm(join(dataDirectory, 'activated', pluginId), {
                    recursive: true,
                    force: true,
                }),
            ]);
        },
    };
};

const isSafePathComponent = (value: string): boolean =>
    value.length > 0 &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    value !== '.' &&
    value !== '..';

type TarEntry = {
    readonly path: string;
    readonly kind: 'file' | 'directory' | 'symlink' | 'device' | 'other';
    readonly size: number;
    readonly contents: Uint8Array;
};

const decompressZstd = async (artifact: Uint8Array): Promise<Uint8Array> => {
    const decompress = zlib.zstdDecompressSync;
    if (decompress) {
        return new Uint8Array(
            decompress(artifact, {
                maxOutputLength: MAX_PLUGIN_ARCHIVE_EXTRACTED_BYTES,
            }),
        );
    }
    return decompressWithSystemZstd(artifact);
};

const decompressWithSystemZstd = (artifact: Uint8Array): Promise<Uint8Array> =>
    new Promise((resolve, reject) => {
        const child = spawn('zstd', ['--decompress', '--stdout', '--quiet'], {
            stdio: ['pipe', 'pipe', 'ignore'],
        });
        const chunks: Buffer[] = [];
        let length = 0;
        let failed = false;
        child.once('error', () => {
            failed = true;
            reject(
                new PluginPolicyError(
                    'pluginIncompatible',
                    'This Node runtime needs zstd support to activate plugin artifacts.',
                ),
            );
        });
        child.stdout.on('data', (chunk: Buffer) => {
            length += chunk.byteLength;
            if (length > MAX_PLUGIN_ARCHIVE_EXTRACTED_BYTES) {
                failed = true;
                child.kill();
                reject(
                    invalidArchive(
                        'Plugin archive exceeds the extracted size limit.',
                    ),
                );
                return;
            }
            chunks.push(chunk);
        });
        child.once('close', code => {
            if (failed) return;
            if (code !== 0) {
                reject(
                    invalidArchive(
                        'Plugin artifact could not be decompressed.',
                    ),
                );
                return;
            }
            resolve(new Uint8Array(Buffer.concat(chunks)));
        });
        child.stdin.end(artifact);
    });

const readPluginArchive = (
    archive: Uint8Array,
    compressedSize: number,
): Map<string, Uint8Array> => {
    const entries: TarEntry[] = [];
    let offset = 0;
    while (offset < archive.byteLength) {
        if (offset + 512 > archive.byteLength) {
            throw invalidArchive('Plugin archive has a truncated tar header.');
        }
        const header = archive.subarray(offset, offset + 512);
        if (header.every(byte => byte === 0)) {
            if (archive.subarray(offset).some(byte => byte !== 0)) {
                throw invalidArchive(
                    'Plugin archive has data after its tar terminator.',
                );
            }
            break;
        }
        validateTarChecksum(header);
        const path = readTarString(header, 0, 100);
        const prefix = readTarString(header, 345, 155);
        const fullPath = prefix ? `${prefix}/${path}` : path;
        const size = readTarOctal(header, 124, 12);
        const kind = tarKind(header[156]);
        const contentsStart = offset + 512;
        const contentsEnd = contentsStart + size;
        if (contentsEnd > archive.byteLength) {
            throw invalidArchive('Plugin archive has a truncated file entry.');
        }
        entries.push({
            path: fullPath,
            kind,
            size,
            contents: archive.slice(contentsStart, contentsEnd),
        });
        offset = contentsStart + Math.ceil(size / 512) * 512;
    }
    validatePluginArchive(
        compressedSize,
        entries.map(({ path, kind, size }) => ({ path, kind, size })),
    );
    const files = new Map<string, Uint8Array>();
    for (const entry of entries) {
        if (entry.kind === 'directory') continue;
        if (!isSafeArchiveEntry(entry.path, entry.kind)) {
            throw invalidArchive('Plugin archive contains an unsafe entry.');
        }
        files.set(entry.path, entry.contents);
    }
    return files;
};

const readTarString = (
    bytes: Uint8Array,
    start: number,
    length: number,
): string => {
    const end = bytes.subarray(start, start + length).indexOf(0);
    return new TextDecoder().decode(
        bytes.subarray(start, end < 0 ? start + length : start + end),
    );
};

const readTarOctal = (
    bytes: Uint8Array,
    start: number,
    length: number,
): number => {
    const value = readTarString(bytes, start, length).trim();
    if (!/^[0-7]+$/.test(value)) {
        throw invalidArchive('Plugin archive has an invalid tar entry size.');
    }
    const size = Number.parseInt(value, 8);
    if (!Number.isSafeInteger(size) || size < 0) {
        throw invalidArchive('Plugin archive has an invalid tar entry size.');
    }
    return size;
};

const validateTarChecksum = (header: Uint8Array): void => {
    const expected = readTarOctal(header, 148, 8);
    const actual = header.reduce(
        (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
        0,
    );
    if (expected !== actual) {
        throw invalidArchive(
            'Plugin archive has an invalid tar header checksum.',
        );
    }
};

const tarKind = (type: number | undefined): TarEntry['kind'] => {
    if (type === 0 || type === 48) return 'file';
    if (type === 53) return 'directory';
    if (type === 50) return 'symlink';
    if (type === 51 || type === 52 || type === 54) return 'device';
    return 'other';
};

const invalidArchive = (message: string): PluginPolicyError =>
    new PluginPolicyError('pluginArtifactInvalid', message);

const isMissingError = (error: unknown): boolean =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT';
