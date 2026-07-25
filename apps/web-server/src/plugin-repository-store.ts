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
export const FIRST_PARTY_PLUGIN_REGISTRY_URL =
    'https://raw.githubusercontent.com/cbnsndwch/cbranch/plugin-registry';
export const FIRST_PARTY_PLUGIN_REGISTRY_ROOT =
    'eyJzaWduZWQiOnsiX3R5cGUiOiJyb290IiwidmVyc2lvbiI6MSwiZXhwaXJlcyI6IjIwMjctMDctMTZUMDE6MzE6NDQuNTM2WiIsImtleXMiOnsiY2EyMWU1ZDM2YjI1YzJlN2JhZDk0ZWJlMTFhZjFjNjQ1MGY1ODg1MTllMDBjNTgwYThjY2RmMmIzMGMyNmQ2ZiI6eyJrZXl0eXBlIjoiZWQyNTUxOSIsImtleXZhbCI6eyJwdWJsaWMiOiJjYzQ4MmVhZjhhZmYzZDIwNjkzMTA2MzMzZjY2ZmU4ZDI5MGJjN2VlNTUxYmVhNWJiODMzN2NlMjkxMGQ1NmVhIn19fSwicm9sZXMiOnsicm9vdCI6eyJrZXlpZHMiOlsiY2EyMWU1ZDM2YjI1YzJlN2JhZDk0ZWJlMTFhZjFjNjQ1MGY1ODg1MTllMDBjNTgwYThjY2RmMmIzMGMyNmQ2ZiJdLCJ0aHJlc2hvbGQiOjF9LCJ0aW1lc3RhbXAiOnsia2V5aWRzIjpbImNhMjFlNWQzNmIyNWMyZTdiYWQ5NGViZTExYWYxYzY0NTBmNTg4NTE5ZTAwYzU4MGE4Y2NkZjJiMzBjMjZkNmYiXSwidGhyZXNob2xkIjoxfSwic25hcHNob3QiOnsia2V5aWRzIjpbImNhMjFlNWQzNmIyNWMyZTdiYWQ5NGViZTExYWYxYzY0NTBmNTg4NTE5ZTAwYzU4MGE4Y2NkZjJiMzBjMjZkNmYiXSwidGhyZXNob2xkIjoxfSwidGFyZ2V0cyI6eyJrZXlpZHMiOlsiY2EyMWU1ZDM2YjI1YzJlN2JhZDk0ZWJlMTFhZjFjNjQ1MGY1ODg1MTllMDBjNTgwYThjY2RmMmIzMGMyNmQ2ZiJdLCJ0aHJlc2hvbGQiOjF9fX0sInNpZ25hdHVyZXMiOlt7ImtleWlkIjoiY2EyMWU1ZDM2YjI1YzJlN2JhZDk0ZWJlMTFhZjFjNjQ1MGY1ODg1MTllMDBjNTgwYThjY2RmMmIzMGMyNmQ2ZiIsInNpZyI6ImNlODI1OTYyN2ZlNTY3NjY5NDhlNjM3MzZjMGRiNDkwY2MyMDI3NTBmMmNmOTlmYzg2MDVjZDMxODE3YjZkODI1MTNmNmZlY2M2MDQzOGI1MjdkODYxOGM3OTM1MWRkMzZkOTUxMmIyY2EwYTRhNTVlN2Y3NDBlN2ZlZDI1ZDA3In1dfQo=';
export const FIRST_PARTY_PLUGIN_REGISTRY_FINGERPRINT =
    'sha256:85aef5664a41cf851120125cff8779a683454901da86e17b437e536fb4024585';
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
    /** Marks that the built-in registry migration has run. */
    defaultsInitialized: Schema.optional(Schema.Boolean),
}) {}

const initialRepositoryFile = (): PluginRepositoryFile =>
    new PluginRepositoryFile({
        version: PLUGIN_REPOSITORY_VERSION,
        defaultsInitialized: true,
        repositories: [
            new StoredRepository({
                repository: new PluginRepository({
                    id: PluginRepositoryId.make('cbranch-official'),
                    kind: 'https',
                    url: FIRST_PARTY_PLUGIN_REGISTRY_URL,
                    publisherFingerprint:
                        FIRST_PARTY_PLUGIN_REGISTRY_FINGERPRINT,
                    trustState: 'trusted',
                    freshness: 'fresh',
                    credentialState: 'not needed',
                }),
                root: FIRST_PARTY_PLUGIN_REGISTRY_ROOT,
            }),
        ],
    });

const isUntrustedFirstPartyRepository = (entry: StoredRepository): boolean =>
    entry.repository.id === 'cbranch-official' &&
    entry.repository.url === FIRST_PARTY_PLUGIN_REGISTRY_URL &&
    entry.repository.trustState === 'untrusted';

const firstPartyRepository = (): StoredRepository =>
    initialRepositoryFile().repositories[0]!;

export interface PluginRepositoryStore {
    readonly list: () => Promise<readonly StoredRepository[]>;
    readonly get: (
        repositoryId: PluginRepositoryId,
    ) => Promise<StoredRepository | undefined>;
    readonly add: (
        kind: PluginRepositorySourceKind,
        url: string,
        credentialState?: PluginRepository['credentialState'],
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
    readonly setCredentialState: (
        repositoryId: PluginRepositoryId,
        credentialState: PluginRepository['credentialState'],
    ) => Promise<PluginRepository>;
    readonly remove: (repositoryId: PluginRepositoryId) => Promise<void>;
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
            const stored = Schema.decodeUnknownSync(PluginRepositoryFile)(
                JSON.parse(await readFile(file, 'utf8')),
            );
            const repositories = stored.repositories.map(entry =>
                isUntrustedFirstPartyRepository(entry)
                    ? firstPartyRepository()
                    : entry,
            );
            if (stored.defaultsInitialized) {
                return new PluginRepositoryFile({ ...stored, repositories });
            }
            // One-time migration for installations that had a registry file before the
            // first-party source shipped. Future writes retain the marker, including an
            // intentionally empty registry after the user removes it.
            return new PluginRepositoryFile({
                ...stored,
                defaultsInitialized: true,
                repositories: repositories.some(
                    entry =>
                        entry.repository.url ===
                        FIRST_PARTY_PLUGIN_REGISTRY_URL,
                )
                    ? repositories
                    : [
                          ...initialRepositoryFile().repositories,
                          ...repositories,
                      ],
            });
        } catch (error) {
            if (
                typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                error.code === 'ENOENT'
            )
                return initialRepositoryFile();
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
                        defaultsInitialized: true,
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
        add: (kind, url, credentialState = 'not needed') =>
            update(current => {
                const repository = new PluginRepository({
                    id: PluginRepositoryId.make(randomUUID()),
                    kind,
                    url,
                    trustState: 'untrusted',
                    freshness: 'unknown',
                    credentialState,
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
        setCredentialState: (repositoryId, credentialState) =>
            update(current => {
                const existing = current.find(
                    entry => entry.repository.id === repositoryId,
                );
                if (!existing)
                    throw new Error('Plugin repository was not found.');
                const repository = new PluginRepository({
                    ...existing.repository,
                    credentialState,
                });
                return [
                    repository,
                    current.map(entry =>
                        entry.repository.id === repositoryId
                            ? new StoredRepository({
                                  ...entry,
                                  repository,
                              })
                            : entry,
                    ),
                ];
            }),
        remove: repositoryId =>
            update(current => {
                if (
                    !current.some(entry => entry.repository.id === repositoryId)
                )
                    throw new Error('Plugin repository was not found.');
                return [
                    undefined,
                    current.filter(
                        entry => entry.repository.id !== repositoryId,
                    ),
                ];
            }),
    };
};
