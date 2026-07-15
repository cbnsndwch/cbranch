import { randomUUID } from 'node:crypto';
import {
    chmod,
    mkdir,
    readFile,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import {
    PluginRepository,
    PluginRepositoryId,
    type PluginRepositorySourceKind,
} from '@cbranch/plugin-contract';
import { Schema } from 'effect';

import { resolvePluginDataDirectory } from './plugin-lock-store';

export const PLUGIN_REPOSITORY_FILE_NAME = 'repositories.json';
const PLUGIN_REPOSITORY_VERSION = 1;

class StoredRepository extends Schema.Class<StoredRepository>(
    'StoredRepository',
)({
    repository: PluginRepository,
    // Public TUF root metadata is retained separately from user-readable config so a
    // trusted root survives restarts without making the lock file a trust store.
    root: Schema.optional(Schema.String),
}) {}

class PluginRepositoryFile extends Schema.Class<PluginRepositoryFile>(
    'PluginRepositoryFile',
)({
    version: Schema.Literal(PLUGIN_REPOSITORY_VERSION),
    repositories: Schema.Array(StoredRepository),
}) {}

export interface PluginRepositoryStore {
    readonly list: () => Promise<readonly StoredRepository[]>;
    readonly get: (
        repositoryId: PluginRepositoryId,
    ) => Promise<StoredRepository | undefined>;
    readonly add: (
        kind: PluginRepositorySourceKind,
        url: string,
    ) => Promise<PluginRepository>;
    readonly trust: (
        repositoryId: PluginRepositoryId,
        fingerprint: string,
        root: Uint8Array,
    ) => Promise<PluginRepository>;
    readonly setRoot: (
        repositoryId: PluginRepositoryId,
        fingerprint: string,
        root: Uint8Array,
    ) => Promise<PluginRepository>;
}

export const makePluginRepositoryStore = (
    options: {
        readonly dataDirectory?: string;
        readonly env?: NodeJS.ProcessEnv;
    } = {},
): PluginRepositoryStore => {
    const directory =
        options.dataDirectory ?? resolvePluginDataDirectory(options.env);
    const file = join(directory, PLUGIN_REPOSITORY_FILE_NAME);
    let writeTail = Promise.resolve();

    const load = async (): Promise<PluginRepositoryFile> => {
        try {
            return Schema.decodeUnknownSync(PluginRepositoryFile)(
                JSON.parse(await readFile(file, 'utf8')),
            );
        } catch (error) {
            if (
                typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                error.code === 'ENOENT'
            )
                return new PluginRepositoryFile({
                    version: PLUGIN_REPOSITORY_VERSION,
                    repositories: [],
                });
            throw error;
        }
    };
    const write = async (repositories: readonly StoredRepository[]) => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700);
        const temporary = join(directory, `.${randomUUID()}.tmp`);
        try {
            await writeFile(
                temporary,
                JSON.stringify(
                    new PluginRepositoryFile({
                        version: PLUGIN_REPOSITORY_VERSION,
                        repositories,
                    }),
                ),
                { mode: 0o600, flag: 'wx' },
            );
            await rename(temporary, file);
            await chmod(file, 0o600);
        } catch (error) {
            await rm(temporary, { force: true });
            throw error;
        }
    };
    const update = async <A>(
        operation: (
            current: readonly StoredRepository[],
        ) => [A, readonly StoredRepository[]],
    ): Promise<A> => {
        const run = async () => {
            const current = await load();
            const [result, next] = operation(current.repositories);
            await write(next);
            return result;
        };
        const next = writeTail.then(run, run);
        writeTail = next.then(
            () => undefined,
            () => undefined,
        );
        return next;
    };

    return {
        list: () =>
            writeTail.then(() => load().then(store => store.repositories)),
        get: async repositoryId =>
            (await writeTail.then(() => load())).repositories.find(
                entry => entry.repository.id === repositoryId,
            ),
        add: (kind, url) =>
            update(current => {
                const repository = new PluginRepository({
                    id: PluginRepositoryId.make(randomUUID()),
                    kind,
                    url,
                    trustState: 'untrusted',
                    freshness: 'unknown',
                    credentialState: 'not needed',
                });
                return [
                    repository,
                    [...current, new StoredRepository({ repository })],
                ];
            }),
        trust: (repositoryId, fingerprint, root) =>
            update(current => {
                const existing = current.find(
                    entry => entry.repository.id === repositoryId,
                );
                if (!existing)
                    throw new Error('Plugin repository was not found.');
                const repository = new PluginRepository({
                    ...existing.repository,
                    publisherFingerprint: fingerprint,
                    trustState: 'trusted',
                });
                return [
                    repository,
                    current.map(entry =>
                        entry.repository.id === repositoryId
                            ? new StoredRepository({
                                  repository,
                                  root: Buffer.from(root).toString('base64'),
                              })
                            : entry,
                    ),
                ];
            }),
        setRoot: (repositoryId, fingerprint, root) =>
            update(current => {
                const existing = current.find(
                    entry => entry.repository.id === repositoryId,
                );
                if (!existing)
                    throw new Error('Plugin repository was not found.');
                const repository = new PluginRepository({
                    ...existing.repository,
                    publisherFingerprint: fingerprint,
                    freshness: 'fresh',
                });
                return [
                    repository,
                    current.map(entry =>
                        entry.repository.id === repositoryId
                            ? new StoredRepository({
                                  repository,
                                  root: Buffer.from(root).toString('base64'),
                              })
                            : entry,
                    ),
                ];
            }),
    };
};
