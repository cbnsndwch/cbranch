// Host-side settings store (docs/spec/12 NF-CFG-2/4/5/6/7; DECISIONS D9).
//
// Human-readable JSON at `$XDG_CONFIG_HOME/cbranch/config.json` (default
// `~/.config/cbranch/config.json`; Windows `%APPDATA%\cbranch\config.json`),
// overridable via `CBRANCH_CONFIG`. This is the SINGLE source for the repo
// switcher's recent list (P1-RECENT-6, server-side). Reads are infallible: a
// missing/unreadable/garbage file falls back to documented defaults rather than
// crashing (NF-CFG-5), and unknown fields are ignored (forward/backward compatible).
// cbranch NEVER writes repository git config (NF-CFG-4) or secrets (NF-CFG-6).

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
    type ChangeSetId,
    ChangeSetId as ChangeSetIdBrand,
    type ChangeSetPullRequest,
    ChangeSetPullRequest as ChangeSetPullRequestSchema,
    Engagement,
    type EngagementColor,
    type EngagementDirectoryImportTarget,
    type EngagementId,
    EngagementId as EngagementIdBrand,
    type EngagementSlug,
    EngagementSlug as EngagementSlugBrand,
    EngagementWorkspace,
    type GitError,
    Oid as OidBrand,
    PullRequestChangeSet,
    RecentRepo,
    type RepoId,
    RepoId as RepoIdBrand,
} from '@cbranch/rpc-contract';
import { Effect, Semaphore } from 'effect';

import { classifyNodeError, gitError } from '../git/errors';

/** Current settings schema version (top-level integer for migration — NF-CFG-7). */
export const CONFIG_VERSION = 5;

/** Local host URL prefix for workspace images stored alongside cbranch's config. */
export const WORKSPACE_AVATAR_PATH_PREFIX = '/sidechannel/workspace-avatar/';

/** Uploaded workspace images are deliberately small enough for a local settings asset. */
export const MAX_WORKSPACE_AVATAR_BYTES = 2 * 1024 * 1024;

export const DEFAULT_BIND = { address: '127.0.0.1', port: 7420 } as const;

/** Configurable limits (NF-LIMIT-1..6) — values are the documented defaults. */
export const DEFAULT_THRESHOLDS = {
    largeDiffLines: 2000,
    largeDiffBytes: 512 * 1024,
    binaryPreviewBytes: 5 * 1024 * 1024,
    inlineContentBytes: 10 * 1024 * 1024,
    mergeEditorBytes: 2 * 1024 * 1024,
    logPageSize: 500,
    rpcPayloadBytes: 1024 * 1024,
} as const;

export interface RecentRepoEntry {
    readonly path: string;
    readonly name: string;
    readonly repoId: string;
    readonly lastOpenedAt: number;
}

/** A resolved repository ready to be added by one atomic workspace import. */
export interface EngagementDirectoryImportRepository {
    readonly path: string;
    readonly name: string;
    readonly repoId: RepoId;
}

/** Host-persisted consulting partition and its ordered open-repository session. */
export interface EngagementEntry {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly color: EngagementColor;
    readonly avatarUrl?: string;
    readonly repoIds: ReadonlyArray<string>;
    readonly openRepoIds: ReadonlyArray<string>;
    readonly activeRepoId?: string;
    readonly changeSets: ReadonlyArray<PullRequestChangeSetEntry>;
    readonly createdAt: number;
    readonly updatedAt: number;
}

export interface ChangeSetPullRequestEntry {
    readonly repoId: string;
    readonly repository: string;
    readonly number: number;
    readonly title: string;
    readonly url: string;
    readonly headRefName: string;
    readonly headRefOid?: string;
    readonly baseRefName: string;
    readonly dependencyNote: string;
}

export interface PullRequestChangeSetEntry {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly pullRequests: ReadonlyArray<ChangeSetPullRequestEntry>;
    readonly createdAt: number;
    readonly updatedAt: number;
}

/** History-grid column visibility (REQ-P6-COL-002); every column defaults to shown. */
export interface HistoryColumns {
    readonly authorName: boolean;
    readonly avatar: boolean;
    readonly date: boolean;
    readonly sha: boolean;
}

export const DEFAULT_COLUMNS: HistoryColumns = {
    authorName: true,
    avatar: true,
    date: true,
    sha: true,
};

export type InferenceProviderKindData =
    | 'claude-code'
    | 'codex'
    | 'opencode'
    | 'openai-compatible'
    | 'local-embeddings';
export type InferenceCapabilityData = 'generation' | 'embeddings';

/** A config-safe reference; credential values never enter cbranch config.json. */
export interface InferenceSecretReferenceData {
    readonly kind: 'environment' | 'secret-store';
    readonly name: string;
}

/** Durable non-secret provider metadata, shared by all workspaces on this host. */
export interface InferenceProfileData {
    readonly id: string;
    readonly label: string;
    readonly provider: InferenceProviderKindData;
    readonly enabled: boolean;
    readonly capabilities: ReadonlyArray<InferenceCapabilityData>;
    readonly modelId?: string;
    readonly endpoint?: string;
    readonly executable?: string;
    readonly secretReference?: InferenceSecretReferenceData;
}

/** An engagement's separate generation and embedding profile selections. */
export interface WorkspaceInferenceDefaultsData {
    readonly generationProfileId?: string;
    readonly embeddingProfileId?: string;
}

export interface Config {
    readonly version: number;
    readonly recentRepos: ReadonlyArray<RecentRepoEntry>;
    readonly engagements: ReadonlyArray<EngagementEntry>;
    readonly activeEngagementId?: string;
    readonly theme: 'light' | 'dark' | 'system';
    readonly locale: string;
    readonly logLevel: 'error' | 'warn' | 'info' | 'debug';
    readonly bind: { readonly address: string; readonly port: number };
    readonly thresholds: Record<string, number>;
    readonly keybindings: Record<string, string>;
    readonly columns: HistoryColumns;
    readonly inferenceProfiles: ReadonlyArray<InferenceProfileData>;
    readonly workspaceInferenceDefaults: Readonly<
        Record<string, WorkspaceInferenceDefaultsData>
    >;
}

export const defaultConfig = (): Config => ({
    version: CONFIG_VERSION,
    recentRepos: [],
    engagements: [],
    activeEngagementId: undefined,
    theme: 'system',
    locale: 'en',
    logLevel: 'info',
    bind: { ...DEFAULT_BIND },
    thresholds: { ...DEFAULT_THRESHOLDS },
    keybindings: {},
    columns: { ...DEFAULT_COLUMNS },
    inferenceProfiles: [],
    workspaceInferenceDefaults: {},
});

/** Resolve the config file path with the documented precedence (NF-CFG-7 / NF-PKG-9). */
export const resolveConfigPath = (
    env: NodeJS.ProcessEnv = process.env,
): string => {
    if (typeof env.CBRANCH_CONFIG === 'string' && env.CBRANCH_CONFIG !== '')
        return env.CBRANCH_CONFIG;
    if (
        process.platform === 'win32' &&
        typeof env.APPDATA === 'string' &&
        env.APPDATA !== ''
    ) {
        return join(env.APPDATA, 'cbranch', 'config.json');
    }
    const xdg =
        typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME !== ''
            ? env.XDG_CONFIG_HOME
            : join(homedir(), '.config');
    return join(xdg, 'cbranch', 'config.json');
};

/**
 * cbranch's own app settings (REQ-P5-CFG-006) — theme/locale/keybindings, persisted in
 * THIS host `config.json`, NEVER in git config (REQ-P5-CFG-005). `keybindings` is the
 * native `Record<commandId, chord>` of user overrides; the engine converts it to/from
 * the wire `KeyBinding[]` at the boundary.
 */
export interface AppSettingsData {
    readonly theme: Config['theme'];
    readonly locale: string;
    readonly keybindings: Record<string, string>;
    readonly columns: HistoryColumns;
}

export interface ConfigStore {
    readonly path: string;
    /** Load the config; ALWAYS succeeds with documented defaults on any problem. */
    readonly load: () => Effect.Effect<Config>;
    readonly listRecent: () => Effect.Effect<ReadonlyArray<RecentRepo>>;
    readonly upsertRecent: (
        entry: RecentRepoEntry,
    ) => Effect.Effect<void, GitError>;
    readonly removeRecent: (repoId: RepoId) => Effect.Effect<void, GitError>;
    readonly renameRecent: (
        repoId: RepoId,
        name: string,
    ) => Effect.Effect<void, GitError>;
    /** Complete consulting workspace snapshot, including explicitly unassigned repos. */
    readonly listEngagements: () => Effect.Effect<EngagementWorkspace>;
    readonly createEngagement: (
        name: string,
        color: EngagementColor,
        avatarUrl?: string,
        slug?: EngagementSlug,
    ) => Effect.Effect<EngagementWorkspace, GitError>;
    /** Atomically upsert resolved recents and open them in an existing or new workspace. */
    readonly importEngagementDirectory: (
        target: EngagementDirectoryImportTarget,
        repositories: ReadonlyArray<EngagementDirectoryImportRepository>,
    ) => Effect.Effect<EngagementWorkspace, GitError>;
    readonly updateEngagement: (
        engagementId: EngagementId,
        patch: {
            readonly name?: string;
            readonly slug?: EngagementSlug;
            readonly color?: EngagementColor;
            readonly avatarUrl?: string | null;
        },
    ) => Effect.Effect<EngagementWorkspace, GitError>;
    /** Persist a validated raster image under cbranch's config directory for a workspace. */
    readonly uploadEngagementAvatar: (
        engagementId: EngagementId,
        bytes: Uint8Array,
    ) => Effect.Effect<{ readonly avatarUrl: string }, GitError>;
    /** Read a previously persisted workspace image by its opaque local filename. */
    readonly readEngagementAvatar: (filename: string) => Effect.Effect<
        | {
              readonly bytes: Uint8Array;
              readonly contentType: string;
          }
        | undefined,
        GitError
    >;
    /** Remove a workspace image and clear its persisted avatar URL. */
    readonly removeEngagementAvatar: (
        engagementId: EngagementId,
    ) => Effect.Effect<EngagementWorkspace, GitError>;
    readonly deleteEngagement: (
        engagementId: EngagementId,
    ) => Effect.Effect<EngagementWorkspace, GitError>;
    /** Persist the workspace presentation order used by the sidebar and manager. */
    readonly reorderEngagements: (
        engagementIds: ReadonlyArray<EngagementId>,
    ) => Effect.Effect<EngagementWorkspace, GitError>;
    readonly assignEngagementRepo: (
        engagementId: EngagementId,
        repoId: RepoId,
    ) => Effect.Effect<EngagementWorkspace, GitError>;
    readonly removeEngagementRepo: (
        engagementId: EngagementId,
        repoId: RepoId,
    ) => Effect.Effect<EngagementWorkspace, GitError>;
    readonly setEngagementSession: (
        engagementId: EngagementId,
        openRepoIds: ReadonlyArray<RepoId>,
        activeRepoId?: RepoId,
    ) => Effect.Effect<EngagementWorkspace, GitError>;
    readonly activateEngagement: (
        engagementId: EngagementId,
    ) => Effect.Effect<EngagementWorkspace, GitError>;
    readonly createChangeSet: (
        engagementId: EngagementId,
        name: string,
        description?: string,
    ) => Effect.Effect<EngagementWorkspace, GitError>;
    readonly updateChangeSet: (
        engagementId: EngagementId,
        changeSetId: ChangeSetId,
        patch: { readonly name?: string; readonly description?: string },
    ) => Effect.Effect<EngagementWorkspace, GitError>;
    readonly deleteChangeSet: (
        engagementId: EngagementId,
        changeSetId: ChangeSetId,
    ) => Effect.Effect<EngagementWorkspace, GitError>;
    readonly setChangeSetItems: (
        engagementId: EngagementId,
        changeSetId: ChangeSetId,
        items: ReadonlyArray<ChangeSetPullRequest>,
    ) => Effect.Effect<EngagementWorkspace, GitError>;
    /** Read app settings (theme/locale/keybindings); infallible (defaults on any problem). */
    readonly getAppSettings: () => Effect.Effect<AppSettingsData>;
    /** Merge a partial patch into app settings and persist (REQ-P5-CFG-006). */
    readonly setAppSettings: (
        patch: Partial<AppSettingsData>,
    ) => Effect.Effect<AppSettingsData, GitError>;
    /** Read the host's non-secret inference provider profiles. */
    readonly getInferenceProfiles: () => Effect.Effect<
        ReadonlyArray<InferenceProfileData>
    >;
    /** Atomically replace host profiles, clearing incompatible workspace defaults. */
    readonly setInferenceProfiles: (
        profiles: ReadonlyArray<InferenceProfileData>,
    ) => Effect.Effect<ReadonlyArray<InferenceProfileData>, GitError>;
    /** Read an engagement's optional inference defaults. */
    readonly getWorkspaceInferenceDefaults: (
        engagementId: EngagementId,
    ) => Effect.Effect<WorkspaceInferenceDefaultsData, GitError>;
    /** Persist only enabled, capability-compatible profile selections. */
    readonly setWorkspaceInferenceDefaults: (
        engagementId: EngagementId,
        defaults: WorkspaceInferenceDefaultsData,
    ) => Effect.Effect<WorkspaceInferenceDefaultsData, GitError>;
}

/**
 * ONE process-wide write permit. Every writer (theme save, upsertRecent, …) runs
 * its whole load→modify→write under this so a concurrent theme save racing an
 * upsertRecent can't lose an update. Reads stay lockless (load is infallible).
 */
const writeLock = Semaphore.makeUnsafe(1);

const missingEngagement = (engagementId: EngagementId): GitError =>
    gitError('engagementNotFound', `engagement ${engagementId} does not exist`);

const missingChangeSet = (changeSetId: ChangeSetId): GitError =>
    gitError('changeSetNotFound', `change set ${changeSetId} does not exist`);

const ENGAGEMENT_SLUG_MAX_LENGTH = 63;
const engagementSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const slugFromName = (name: string): string => {
    const slug = name
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, ENGAGEMENT_SLUG_MAX_LENGTH)
        .replace(/-+$/g, '');
    return slug === '' ? 'workspace' : slug;
};

const validEngagementSlug = (value: string): string | undefined => {
    const slug = value.trim();
    return slug.length <= ENGAGEMENT_SLUG_MAX_LENGTH &&
        engagementSlugPattern.test(slug)
        ? slug
        : undefined;
};

const uniqueEngagementSlug = (
    base: string,
    used: ReadonlySet<string>,
): string => {
    if (!used.has(base)) return base;
    for (let suffix = 2; ; suffix += 1) {
        const ending = `-${suffix}`;
        const candidate = `${base
            .slice(0, ENGAGEMENT_SLUG_MAX_LENGTH - ending.length)
            .replace(/-+$/g, '')}${ending}`;
        if (!used.has(candidate)) return candidate;
    }
};

const createEngagementEntry = (
    config: Config,
    rawName: string,
    color: EngagementColor,
    rawAvatarUrl: string | undefined,
    rawSlug: EngagementSlug | undefined,
): Effect.Effect<EngagementEntry, GitError> => {
    const name = rawName.trim();
    if (name === '')
        return Effect.fail(
            gitError('gitFailed', 'engagement name cannot be empty'),
        );
    const avatarUrl =
        rawAvatarUrl === undefined
            ? undefined
            : normalizeAvatarUrl(rawAvatarUrl);
    if (rawAvatarUrl !== undefined && avatarUrl === undefined)
        return Effect.fail(
            gitError(
                'gitFailed',
                'workspace avatar must be an http(s) image URL or a local upload',
            ),
        );
    const requestedSlug =
        rawSlug === undefined ? undefined : validEngagementSlug(rawSlug);
    if (rawSlug !== undefined && requestedSlug === undefined)
        return Effect.fail(
            gitError(
                'gitFailed',
                'workspace slug must use lowercase letters, numbers, and hyphens',
            ),
        );
    const usedSlugs = new Set(
        config.engagements.map(engagement => engagement.slug),
    );
    if (requestedSlug !== undefined && usedSlugs.has(requestedSlug))
        return Effect.fail(
            gitError(
                'gitFailed',
                `workspace slug "${requestedSlug}" is already in use`,
            ),
        );
    const now = Date.now();
    return Effect.succeed({
        id: randomUUID(),
        name,
        slug:
            requestedSlug ??
            uniqueEngagementSlug(slugFromName(name), usedSlugs),
        color,
        avatarUrl,
        repoIds: [],
        openRepoIds: [],
        changeSets: [],
        createdAt: now,
        updatedAt: now,
    });
};

type WorkspaceAvatarType = {
    readonly extension: 'png' | 'jpg' | 'gif' | 'webp';
    readonly contentType:
        | 'image/png'
        | 'image/jpeg'
        | 'image/gif'
        | 'image/webp';
};

const WORKSPACE_AVATAR_TYPES: ReadonlyArray<WorkspaceAvatarType> = [
    { extension: 'png', contentType: 'image/png' },
    { extension: 'jpg', contentType: 'image/jpeg' },
    { extension: 'gif', contentType: 'image/gif' },
    { extension: 'webp', contentType: 'image/webp' },
];

const avatarTypeFromBytes = (
    bytes: Uint8Array,
): WorkspaceAvatarType | undefined => {
    if (
        bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
    )
        return WORKSPACE_AVATAR_TYPES[0];
    if (
        bytes.length >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff
    )
        return WORKSPACE_AVATAR_TYPES[1];
    if (
        bytes.length >= 6 &&
        bytes[0] === 0x47 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x38 &&
        (bytes[4] === 0x37 || bytes[4] === 0x39) &&
        bytes[5] === 0x61
    )
        return WORKSPACE_AVATAR_TYPES[2];
    if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
    )
        return WORKSPACE_AVATAR_TYPES[3];
    return undefined;
};

const avatarFilename = (
    engagementId: EngagementId,
    extension: WorkspaceAvatarType['extension'],
): string =>
    `${createHash('sha256').update(engagementId).digest('hex')}.${extension}`;

const avatarFilenamePattern = /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/;

const localAvatarUrlPattern = new RegExp(
    `^${WORKSPACE_AVATAR_PATH_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[a-f0-9]{64}\\.(png|jpg|gif|webp)\\?v=[0-9a-f-]{36}$`,
);

const avatarDirectoryFor = (configPath: string): string =>
    join(dirname(configPath), 'workspace-avatars');

const removeAvatarFiles = async (
    directory: string,
    engagementId: EngagementId,
    keepExtension?: WorkspaceAvatarType['extension'],
): Promise<void> => {
    await Promise.all(
        WORKSPACE_AVATAR_TYPES.filter(
            ({ extension }) => extension !== keepExtension,
        ).map(async ({ extension }) => {
            try {
                await unlink(
                    join(directory, avatarFilename(engagementId, extension)),
                );
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw error;
            }
        }),
    );
};

export const makeConfigStore = (opts?: {
    readonly configPath?: string;
    readonly env?: NodeJS.ProcessEnv;
}): ConfigStore => {
    const path = opts?.configPath ?? resolveConfigPath(opts?.env);

    const load = (): Effect.Effect<Config> =>
        Effect.map(
            Effect.tryPromise({
                try: () => readFile(path, 'utf8'),
                catch: () => null,
            }).pipe(Effect.orElseSucceed(() => null)),
            raw => (raw === null ? defaultConfig() : normalizeConfig(raw)),
        );

    const save = (config: Config): Effect.Effect<void, GitError> =>
        Effect.tryPromise({
            try: async () => {
                await mkdir(dirname(path), { recursive: true });
                const json = `${JSON.stringify({ ...config, version: CONFIG_VERSION }, null, 2)}\n`;
                // Atomic write: write a sibling temp file then rename over the target so a
                // crash mid-write can't leave a half-written config.json (NF-CFG-5).
                const tmp = `${path}.${randomUUID()}.tmp`;
                await writeFile(tmp, json, 'utf8');
                await rename(tmp, path);
            },
            catch: classifyNodeError,
        });

    // Serialize the whole read→modify→write under the single write permit so
    // concurrent writers don't clobber each other's updates (lost-update race).
    const update = (
        f: (config: Config) => Config,
    ): Effect.Effect<void, GitError> =>
        writeLock.withPermits(1)(
            Effect.flatMap(load(), config => save(f(config))),
        );

    const mutate = (
        f: (recents: RecentRepoEntry[]) => RecentRepoEntry[],
    ): Effect.Effect<void, GitError> =>
        update(config => ({
            ...config,
            recentRepos: f([...config.recentRepos]),
        }));

    const updateWorkspace = (
        f: (config: Config) => Effect.Effect<Config, GitError>,
    ): Effect.Effect<EngagementWorkspace, GitError> =>
        writeLock.withPermits(1)(
            Effect.gen(function* () {
                const config = yield* load();
                const next = yield* f(config);
                yield* save(next);
                return toEngagementWorkspace(next);
            }),
        );

    return {
        path,
        load,
        listRecent: () =>
            Effect.map(load(), config =>
                config.recentRepos.map(
                    e =>
                        new RecentRepo({
                            path: e.path,
                            name: e.name,
                            repoId: RepoIdBrand.make(e.repoId),
                            lastOpenedAt: e.lastOpenedAt,
                        }),
                ),
            ),
        // Move/insert at the top, de-duplicated by resolved path (P1-RECENT-1/3).
        upsertRecent: entry =>
            mutate(recents => [
                entry,
                ...recents.filter(r => r.path !== entry.path),
            ]),
        removeRecent: repoId =>
            update(config => ({
                ...config,
                recentRepos: config.recentRepos.filter(
                    r => r.repoId !== repoId,
                ),
                engagements: config.engagements.map(engagement => {
                    const repoIds = engagement.repoIds.filter(
                        id => id !== repoId,
                    );
                    const openRepoIds = engagement.openRepoIds.filter(
                        id => id !== repoId,
                    );
                    return {
                        ...engagement,
                        repoIds,
                        openRepoIds,
                        changeSets: scrubChangeSetRepo(
                            engagement.changeSets,
                            repoId,
                        ),
                        activeRepoId:
                            engagement.activeRepoId === repoId
                                ? openRepoIds[0]
                                : engagement.activeRepoId,
                    };
                }),
            })),
        renameRecent: (repoId, name) =>
            mutate(recents =>
                recents.map(r => (r.repoId === repoId ? { ...r, name } : r)),
            ),
        listEngagements: () =>
            Effect.map(load(), config => toEngagementWorkspace(config)),
        createEngagement: (rawName, color, rawAvatarUrl, rawSlug) =>
            updateWorkspace(config =>
                Effect.map(
                    createEngagementEntry(
                        config,
                        rawName,
                        color,
                        rawAvatarUrl,
                        rawSlug,
                    ),
                    entry => ({
                        ...config,
                        engagements: [...config.engagements, entry],
                        activeEngagementId: entry.id,
                    }),
                ),
            ),
        importEngagementDirectory: (target, repositories) =>
            updateWorkspace(config =>
                Effect.gen(function* () {
                    const imported: EngagementDirectoryImportRepository[] = [];
                    const seenRepoIds = new Set<string>();
                    for (const repository of repositories) {
                        if (
                            repository.path === '' ||
                            repository.name === '' ||
                            repository.repoId === '' ||
                            seenRepoIds.has(repository.repoId)
                        )
                            continue;
                        seenRepoIds.add(repository.repoId);
                        imported.push(repository);
                    }
                    if (imported.length === 0)
                        return yield* Effect.fail(
                            gitError(
                                'repoUnavailable',
                                'no selected repository is available for import',
                            ),
                        );

                    const existing =
                        target.kind === 'existing'
                            ? config.engagements.find(
                                  engagement =>
                                      engagement.id === target.engagementId,
                              )
                            : undefined;
                    if (target.kind === 'existing' && !existing)
                        return yield* Effect.fail(
                            missingEngagement(target.engagementId),
                        );
                    const destination =
                        target.kind === 'existing'
                            ? existing!
                            : yield* createEngagementEntry(
                                  config,
                                  target.name,
                                  target.color,
                                  undefined,
                                  target.slug,
                              );

                    for (const repository of imported) {
                        const owner = config.engagements.find(engagement =>
                            engagement.repoIds.includes(repository.repoId),
                        );
                        if (owner && owner.id !== destination.id)
                            return yield* Effect.fail(
                                gitError(
                                    'repoUnavailable',
                                    'a selected repository belongs to another workspace',
                                ),
                            );
                    }

                    const now = Date.now();
                    const importedRepoIds = imported.map(
                        repository => repository.repoId,
                    );
                    const members = new Set(destination.repoIds);
                    const open = new Set(destination.openRepoIds);
                    const nextDestination: EngagementEntry = {
                        ...destination,
                        repoIds: [
                            ...destination.repoIds,
                            ...importedRepoIds.filter(repoId => {
                                if (members.has(repoId)) return false;
                                members.add(repoId);
                                return true;
                            }),
                        ],
                        openRepoIds: [
                            ...destination.openRepoIds,
                            ...importedRepoIds.filter(repoId => {
                                if (open.has(repoId)) return false;
                                open.add(repoId);
                                return true;
                            }),
                        ],
                        activeRepoId:
                            importedRepoIds[importedRepoIds.length - 1],
                        updatedAt: now,
                    };
                    const importedIds = new Set<string>(importedRepoIds);
                    const importedPaths = new Set(
                        imported.map(repository => repository.path),
                    );
                    return {
                        ...config,
                        recentRepos: [
                            ...imported.map(repository => ({
                                path: repository.path,
                                name: repository.name,
                                repoId: repository.repoId,
                                lastOpenedAt: now,
                            })),
                            ...config.recentRepos.filter(
                                repository =>
                                    !importedIds.has(repository.repoId) &&
                                    !importedPaths.has(repository.path),
                            ),
                        ],
                        engagements:
                            target.kind === 'existing'
                                ? config.engagements.map(engagement =>
                                      engagement.id === destination.id
                                          ? nextDestination
                                          : engagement,
                                  )
                                : [...config.engagements, nextDestination],
                        activeEngagementId: destination.id,
                    };
                }),
            ),
        updateEngagement: (engagementId, patch) =>
            updateWorkspace(config => {
                const current = config.engagements.find(
                    engagement => engagement.id === engagementId,
                );
                if (!current)
                    return Effect.fail(missingEngagement(engagementId));
                const name = patch.name?.trim();
                if (name !== undefined && name === '')
                    return Effect.fail(
                        gitError(
                            'gitFailed',
                            'engagement name cannot be empty',
                        ),
                    );
                const slug =
                    patch.slug === undefined
                        ? current.slug
                        : validEngagementSlug(patch.slug);
                if (slug === undefined)
                    return Effect.fail(
                        gitError(
                            'gitFailed',
                            'workspace slug must use lowercase letters, numbers, and hyphens',
                        ),
                    );
                if (
                    slug !== current.slug &&
                    config.engagements.some(
                        engagement =>
                            engagement.id !== engagementId &&
                            engagement.slug === slug,
                    )
                )
                    return Effect.fail(
                        gitError(
                            'gitFailed',
                            `workspace slug "${slug}" is already in use`,
                        ),
                    );
                const avatarUrl =
                    patch.avatarUrl === undefined || patch.avatarUrl === null
                        ? undefined
                        : normalizeAvatarUrl(patch.avatarUrl);
                if (
                    patch.avatarUrl !== undefined &&
                    patch.avatarUrl !== null &&
                    avatarUrl === undefined
                )
                    return Effect.fail(
                        gitError(
                            'gitFailed',
                            'workspace avatar must be an http(s) image URL or a local upload',
                        ),
                    );
                return Effect.succeed({
                    ...config,
                    engagements: config.engagements.map(engagement =>
                        engagement.id === engagementId
                            ? {
                                  ...engagement,
                                  name: name ?? engagement.name,
                                  slug,
                                  color: patch.color ?? engagement.color,
                                  avatarUrl:
                                      patch.avatarUrl === undefined
                                          ? engagement.avatarUrl
                                          : avatarUrl,
                                  updatedAt: Date.now(),
                              }
                            : engagement,
                    ),
                });
            }),
        uploadEngagementAvatar: (engagementId, bytes) => {
            if (bytes.length === 0 || bytes.length > MAX_WORKSPACE_AVATAR_BYTES)
                return Effect.fail(
                    gitError(
                        'gitFailed',
                        `workspace avatar must be at most ${MAX_WORKSPACE_AVATAR_BYTES} bytes`,
                    ),
                );
            const type = avatarTypeFromBytes(bytes);
            if (!type)
                return Effect.fail(
                    gitError(
                        'gitFailed',
                        'workspace avatar must be a PNG, JPEG, GIF, or WebP image',
                    ),
                );
            return writeLock.withPermits(1)(
                Effect.gen(function* () {
                    const config = yield* load();
                    if (
                        !config.engagements.some(
                            engagement => engagement.id === engagementId,
                        )
                    )
                        return yield* Effect.fail(
                            missingEngagement(engagementId),
                        );
                    const directory = avatarDirectoryFor(path);
                    const filename = avatarFilename(
                        engagementId,
                        type.extension,
                    );
                    const avatarPath = join(directory, filename);
                    yield* Effect.tryPromise({
                        try: async () => {
                            await mkdir(directory, { recursive: true });
                            const temporaryPath = `${avatarPath}.${randomUUID()}.tmp`;
                            await writeFile(temporaryPath, bytes);
                            await rename(temporaryPath, avatarPath);
                            await removeAvatarFiles(
                                directory,
                                engagementId,
                                type.extension,
                            );
                        },
                        catch: classifyNodeError,
                    });
                    const avatarUrl = `${WORKSPACE_AVATAR_PATH_PREFIX}${filename}?v=${randomUUID()}`;
                    yield* save({
                        ...config,
                        engagements: config.engagements.map(engagement =>
                            engagement.id === engagementId
                                ? Object.assign({}, engagement, {
                                      avatarUrl,
                                      updatedAt: Date.now(),
                                  })
                                : engagement,
                        ),
                    });
                    return { avatarUrl };
                }),
            );
        },
        readEngagementAvatar: filename => {
            const match = avatarFilenamePattern.exec(filename);
            if (!match) return Effect.succeed(undefined);
            const type = WORKSPACE_AVATAR_TYPES.find(
                candidate => candidate.extension === match[1],
            );
            if (!type) return Effect.succeed(undefined);
            return Effect.tryPromise({
                try: async () => {
                    try {
                        return {
                            bytes: new Uint8Array(
                                await readFile(
                                    join(avatarDirectoryFor(path), filename),
                                ),
                            ),
                            contentType: type.contentType,
                        };
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                            return undefined;
                        throw error;
                    }
                },
                catch: classifyNodeError,
            });
        },
        removeEngagementAvatar: engagementId =>
            writeLock.withPermits(1)(
                Effect.gen(function* () {
                    const config = yield* load();
                    if (
                        !config.engagements.some(
                            engagement => engagement.id === engagementId,
                        )
                    )
                        return yield* Effect.fail(
                            missingEngagement(engagementId),
                        );
                    const next = {
                        ...config,
                        engagements: config.engagements.map(engagement =>
                            engagement.id === engagementId
                                ? Object.assign({}, engagement, {
                                      avatarUrl: undefined,
                                      updatedAt: Date.now(),
                                  })
                                : engagement,
                        ),
                    };
                    yield* save(next);
                    yield* Effect.tryPromise({
                        try: () =>
                            removeAvatarFiles(
                                avatarDirectoryFor(path),
                                engagementId,
                            ),
                        catch: classifyNodeError,
                    });
                    return toEngagementWorkspace(next);
                }),
            ),
        deleteEngagement: engagementId =>
            updateWorkspace(config => {
                if (
                    !config.engagements.some(
                        engagement => engagement.id === engagementId,
                    )
                )
                    return Effect.fail(missingEngagement(engagementId));
                const engagements = config.engagements.filter(
                    engagement => engagement.id !== engagementId,
                );
                return Effect.succeed({
                    ...config,
                    engagements,
                    activeEngagementId:
                        config.activeEngagementId === engagementId
                            ? engagements[0]?.id
                            : config.activeEngagementId,
                });
            }),
        reorderEngagements: engagementIds =>
            updateWorkspace(config => {
                const ids = [...engagementIds];
                const byId = new Map(
                    config.engagements.map(engagement => [
                        engagement.id,
                        engagement,
                    ]),
                );
                if (
                    ids.length !== config.engagements.length ||
                    new Set(ids).size !== ids.length ||
                    ids.some(id => !byId.has(id))
                )
                    return Effect.fail(
                        gitError(
                            'gitFailed',
                            'workspace order must contain every workspace exactly once',
                        ),
                    );
                return Effect.succeed({
                    ...config,
                    engagements: ids.map(id => byId.get(id)!),
                });
            }),
        assignEngagementRepo: (engagementId, repoId) =>
            updateWorkspace(config => {
                if (
                    !config.engagements.some(
                        engagement => engagement.id === engagementId,
                    )
                )
                    return Effect.fail(missingEngagement(engagementId));
                if (!config.recentRepos.some(repo => repo.repoId === repoId))
                    return Effect.fail(
                        gitError(
                            'repoUnavailable',
                            'repository is not available in the recent list',
                        ),
                    );
                const now = Date.now();
                return Effect.succeed({
                    ...config,
                    activeEngagementId: engagementId,
                    engagements: config.engagements.map(engagement => {
                        const withoutRepo = engagement.repoIds.filter(
                            id => id !== repoId,
                        );
                        const withoutOpen = engagement.openRepoIds.filter(
                            id => id !== repoId,
                        );
                        if (engagement.id !== engagementId)
                            return {
                                ...engagement,
                                repoIds: withoutRepo,
                                openRepoIds: withoutOpen,
                                changeSets: scrubChangeSetRepo(
                                    engagement.changeSets,
                                    repoId,
                                ),
                                activeRepoId:
                                    engagement.activeRepoId === repoId
                                        ? withoutOpen[0]
                                        : engagement.activeRepoId,
                                updatedAt:
                                    withoutRepo.length ===
                                    engagement.repoIds.length
                                        ? engagement.updatedAt
                                        : now,
                            };
                        return {
                            ...engagement,
                            repoIds: [...withoutRepo, repoId],
                            openRepoIds: [...withoutOpen, repoId],
                            activeRepoId: repoId,
                            updatedAt: now,
                        };
                    }),
                });
            }),
        removeEngagementRepo: (engagementId, repoId) =>
            updateWorkspace(config => {
                const current = config.engagements.find(
                    engagement => engagement.id === engagementId,
                );
                if (!current)
                    return Effect.fail(missingEngagement(engagementId));
                const openRepoIds = current.openRepoIds.filter(
                    id => id !== repoId,
                );
                return Effect.succeed({
                    ...config,
                    engagements: config.engagements.map(engagement =>
                        engagement.id === engagementId
                            ? {
                                  ...engagement,
                                  repoIds: engagement.repoIds.filter(
                                      id => id !== repoId,
                                  ),
                                  openRepoIds,
                                  changeSets: scrubChangeSetRepo(
                                      engagement.changeSets,
                                      repoId,
                                  ),
                                  activeRepoId:
                                      engagement.activeRepoId === repoId
                                          ? openRepoIds[0]
                                          : engagement.activeRepoId,
                                  updatedAt: Date.now(),
                              }
                            : engagement,
                    ),
                });
            }),
        setEngagementSession: (engagementId, requestedOpen, activeRepoId) =>
            updateWorkspace(config => {
                const current = config.engagements.find(
                    engagement => engagement.id === engagementId,
                );
                if (!current)
                    return Effect.fail(missingEngagement(engagementId));
                const members = new Set(current.repoIds);
                const openRepoIds = [...new Set(requestedOpen)];
                if (openRepoIds.some(repoId => !members.has(repoId)))
                    return Effect.fail(
                        gitError(
                            'repoUnavailable',
                            'an open repository does not belong to this engagement',
                        ),
                    );
                if (
                    activeRepoId !== undefined &&
                    !openRepoIds.includes(activeRepoId)
                )
                    return Effect.fail(
                        gitError(
                            'repoUnavailable',
                            'the active repository must be one of the open repositories',
                        ),
                    );
                return Effect.succeed({
                    ...config,
                    activeEngagementId: engagementId,
                    engagements: config.engagements.map(engagement =>
                        engagement.id === engagementId
                            ? {
                                  ...engagement,
                                  openRepoIds,
                                  activeRepoId,
                                  updatedAt: Date.now(),
                              }
                            : engagement,
                    ),
                });
            }),
        activateEngagement: engagementId =>
            updateWorkspace(config =>
                config.engagements.some(
                    engagement => engagement.id === engagementId,
                )
                    ? Effect.succeed({
                          ...config,
                          activeEngagementId: engagementId,
                      })
                    : Effect.fail(missingEngagement(engagementId)),
            ),
        createChangeSet: (engagementId, rawName, description) =>
            updateWorkspace(config => {
                const current = config.engagements.find(
                    engagement => engagement.id === engagementId,
                );
                if (!current)
                    return Effect.fail(missingEngagement(engagementId));
                const name = rawName.trim();
                if (name === '')
                    return Effect.fail(
                        gitError(
                            'gitFailed',
                            'change set name cannot be empty',
                        ),
                    );
                const now = Date.now();
                const changeSet: PullRequestChangeSetEntry = {
                    id: randomUUID(),
                    name,
                    description: description?.trim() ?? '',
                    pullRequests: [],
                    createdAt: now,
                    updatedAt: now,
                };
                return Effect.succeed({
                    ...config,
                    engagements: config.engagements.map(engagement =>
                        engagement.id === engagementId
                            ? {
                                  ...engagement,
                                  changeSets: [
                                      ...engagement.changeSets,
                                      changeSet,
                                  ],
                                  updatedAt: now,
                              }
                            : engagement,
                    ),
                });
            }),
        updateChangeSet: (engagementId, changeSetId, patch) =>
            updateWorkspace(config => {
                const current = config.engagements.find(
                    engagement => engagement.id === engagementId,
                );
                if (!current)
                    return Effect.fail(missingEngagement(engagementId));
                if (
                    !current.changeSets.some(
                        changeSet => changeSet.id === changeSetId,
                    )
                )
                    return Effect.fail(missingChangeSet(changeSetId));
                const name = patch.name?.trim();
                if (name !== undefined && name === '')
                    return Effect.fail(
                        gitError(
                            'gitFailed',
                            'change set name cannot be empty',
                        ),
                    );
                const now = Date.now();
                return Effect.succeed({
                    ...config,
                    engagements: config.engagements.map(engagement =>
                        engagement.id === engagementId
                            ? {
                                  ...engagement,
                                  changeSets: engagement.changeSets.map(
                                      changeSet =>
                                          changeSet.id === changeSetId
                                              ? {
                                                    ...changeSet,
                                                    name:
                                                        name ?? changeSet.name,
                                                    description:
                                                        patch.description !==
                                                        undefined
                                                            ? patch.description.trim()
                                                            : changeSet.description,
                                                    updatedAt: now,
                                                }
                                              : changeSet,
                                  ),
                                  updatedAt: now,
                              }
                            : engagement,
                    ),
                });
            }),
        deleteChangeSet: (engagementId, changeSetId) =>
            updateWorkspace(config => {
                const current = config.engagements.find(
                    engagement => engagement.id === engagementId,
                );
                if (!current)
                    return Effect.fail(missingEngagement(engagementId));
                if (
                    !current.changeSets.some(
                        changeSet => changeSet.id === changeSetId,
                    )
                )
                    return Effect.fail(missingChangeSet(changeSetId));
                const now = Date.now();
                return Effect.succeed({
                    ...config,
                    engagements: config.engagements.map(engagement =>
                        engagement.id === engagementId
                            ? {
                                  ...engagement,
                                  changeSets: engagement.changeSets.filter(
                                      changeSet => changeSet.id !== changeSetId,
                                  ),
                                  updatedAt: now,
                              }
                            : engagement,
                    ),
                });
            }),
        setChangeSetItems: (engagementId, changeSetId, items) =>
            updateWorkspace(config => {
                const current = config.engagements.find(
                    engagement => engagement.id === engagementId,
                );
                if (!current)
                    return Effect.fail(missingEngagement(engagementId));
                if (
                    !current.changeSets.some(
                        changeSet => changeSet.id === changeSetId,
                    )
                )
                    return Effect.fail(missingChangeSet(changeSetId));
                const members = new Set(current.repoIds);
                const seen = new Set<string>();
                for (const item of items) {
                    if (!members.has(item.repoId))
                        return Effect.fail(
                            gitError(
                                'repoUnavailable',
                                'a change-set pull request does not belong to this engagement',
                            ),
                        );
                    const key = `${item.repoId}\0${item.number}`;
                    if (seen.has(key))
                        return Effect.fail(
                            gitError(
                                'gitFailed',
                                'a pull request may appear only once in a change set',
                            ),
                        );
                    seen.add(key);
                }
                const nextItems = items.map(toChangeSetPullRequestEntry);
                const now = Date.now();
                return Effect.succeed({
                    ...config,
                    engagements: config.engagements.map(engagement =>
                        engagement.id === engagementId
                            ? {
                                  ...engagement,
                                  changeSets: engagement.changeSets.map(
                                      changeSet =>
                                          changeSet.id === changeSetId
                                              ? {
                                                    ...changeSet,
                                                    pullRequests: nextItems,
                                                    updatedAt: now,
                                                }
                                              : changeSet,
                                  ),
                                  updatedAt: now,
                              }
                            : engagement,
                    ),
                });
            }),
        getAppSettings: () =>
            Effect.map(load(), config => ({
                theme: config.theme,
                locale: config.locale,
                keybindings: config.keybindings,
                columns: config.columns,
            })),
        setAppSettings: patch =>
            writeLock.withPermits(1)(
                Effect.flatMap(load(), config => {
                    const next: AppSettingsData = {
                        theme: patch.theme ?? config.theme,
                        locale: patch.locale ?? config.locale,
                        keybindings: patch.keybindings ?? config.keybindings,
                        columns: patch.columns ?? config.columns,
                    };
                    return Effect.as(save({ ...config, ...next }), next);
                }),
            ),
        getInferenceProfiles: () =>
            Effect.map(load(), config => config.inferenceProfiles),
        setInferenceProfiles: profiles =>
            writeLock.withPermits(1)(
                Effect.flatMap(load(), config => {
                    const normalized = normalizeInferenceProfiles(profiles);
                    if (normalized.length !== profiles.length)
                        return Effect.fail(
                            gitError(
                                'gitFailed',
                                'Inference profiles must be valid, non-secret provider metadata with unique IDs.',
                            ),
                        );
                    const workspaceInferenceDefaults =
                        sanitizeWorkspaceInferenceDefaults(
                            config.workspaceInferenceDefaults,
                            normalized,
                        );
                    return Effect.as(
                        save({
                            ...config,
                            inferenceProfiles: normalized,
                            workspaceInferenceDefaults,
                        }),
                        normalized,
                    );
                }),
            ),
        getWorkspaceInferenceDefaults: engagementId =>
            Effect.flatMap(load(), config =>
                config.engagements.some(
                    engagement => engagement.id === engagementId,
                )
                    ? Effect.succeed(
                          config.workspaceInferenceDefaults[engagementId] ?? {},
                      )
                    : Effect.fail(missingEngagement(engagementId)),
            ),
        setWorkspaceInferenceDefaults: (engagementId, defaults) =>
            writeLock.withPermits(1)(
                Effect.flatMap(load(), config => {
                    if (
                        !config.engagements.some(
                            engagement => engagement.id === engagementId,
                        )
                    )
                        return Effect.fail(missingEngagement(engagementId));
                    const normalized = normalizeWorkspaceInferenceDefault(
                        defaults,
                        config.inferenceProfiles,
                    );
                    if (normalized === undefined)
                        return Effect.fail(
                            gitError(
                                'gitFailed',
                                'Workspace inference defaults must select enabled profiles with matching capabilities.',
                            ),
                        );
                    const workspaceInferenceDefaults = {
                        ...config.workspaceInferenceDefaults,
                        [engagementId]: normalized,
                    };
                    return Effect.as(
                        save({ ...config, workspaceInferenceDefaults }),
                        normalized,
                    );
                }),
            ),
    };
};

/** Defensive parse: pick known, well-typed fields; ignore everything else (NF-CFG-5). */
const normalizeConfig = (raw: string): Config => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return defaultConfig();
    }
    if (typeof parsed !== 'object' || parsed === null) return defaultConfig();
    const obj = parsed as Record<string, unknown>;
    const base = defaultConfig();
    return {
        version: typeof obj.version === 'number' ? obj.version : base.version,
        recentRepos: normalizeRecents(obj.recentRepos),
        engagements: normalizeEngagements(obj.engagements),
        activeEngagementId:
            typeof obj.activeEngagementId === 'string'
                ? obj.activeEngagementId
                : undefined,
        theme:
            obj.theme === 'light' ||
            obj.theme === 'dark' ||
            obj.theme === 'system'
                ? obj.theme
                : base.theme,
        locale: typeof obj.locale === 'string' ? obj.locale : base.locale,
        logLevel: isLogLevel(obj.logLevel) ? obj.logLevel : base.logLevel,
        bind: normalizeBind(obj.bind, base.bind),
        thresholds: { ...base.thresholds, ...pickNumbers(obj.thresholds) },
        keybindings: pickStrings(obj.keybindings),
        columns: normalizeColumns(obj.columns),
        inferenceProfiles: normalizeInferenceProfiles(obj.inferenceProfiles),
        workspaceInferenceDefaults: sanitizeWorkspaceInferenceDefaults(
            obj.workspaceInferenceDefaults,
            normalizeInferenceProfiles(obj.inferenceProfiles),
        ),
    };
};

const INFERENCE_PROFILE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const INFERENCE_REFERENCE_NAME = /^[A-Za-z_][A-Za-z0-9_./-]*$/;
const INFERENCE_ENDPOINT = /^https?:\/\/[^/?#@]+(?:\/[^?#]*)?$/i;

const inferenceProviderKinds = new Set<InferenceProviderKindData>([
    'claude-code',
    'codex',
    'opencode',
    'openai-compatible',
    'local-embeddings',
]);
const inferenceCapabilities = new Set<InferenceCapabilityData>([
    'generation',
    'embeddings',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeInferenceSecretReference = (
    value: unknown,
): InferenceSecretReferenceData | undefined => {
    if (!isRecord(value)) return undefined;
    const kind = value.kind;
    const name = value.name;
    if (
        (kind !== 'environment' && kind !== 'secret-store') ||
        typeof name !== 'string' ||
        name.length === 0 ||
        name.length > 128 ||
        !INFERENCE_REFERENCE_NAME.test(name)
    )
        return undefined;
    return { kind, name };
};

const normalizeInferenceProfile = (
    value: unknown,
): InferenceProfileData | undefined => {
    if (!isRecord(value)) return undefined;
    const { id, label, provider, enabled, capabilities } = value;
    if (
        typeof id !== 'string' ||
        id.length === 0 ||
        id.length > 96 ||
        !INFERENCE_PROFILE_ID.test(id) ||
        typeof label !== 'string' ||
        label.length === 0 ||
        label.length > 160 ||
        typeof provider !== 'string' ||
        !inferenceProviderKinds.has(provider as InferenceProviderKindData) ||
        typeof enabled !== 'boolean' ||
        !Array.isArray(capabilities) ||
        capabilities.length === 0 ||
        capabilities.length > 2 ||
        capabilities.some(
            capability =>
                typeof capability !== 'string' ||
                !inferenceCapabilities.has(
                    capability as InferenceCapabilityData,
                ),
        ) ||
        new Set(capabilities).size !== capabilities.length
    )
        return undefined;
    const modelId = value.modelId;
    if (
        modelId !== undefined &&
        (typeof modelId !== 'string' ||
            modelId.length === 0 ||
            modelId.length > 200)
    )
        return undefined;
    const endpoint = value.endpoint;
    const executable = value.executable;
    const isRemote = provider === 'openai-compatible';
    if (
        (isRemote &&
            (typeof endpoint !== 'string' ||
                !INFERENCE_ENDPOINT.test(endpoint) ||
                executable !== undefined)) ||
        (!isRemote &&
            (endpoint !== undefined ||
                typeof executable !== 'string' ||
                executable.length === 0 ||
                executable.length > 1_024))
    )
        return undefined;
    const secretReference =
        value.secretReference === undefined
            ? undefined
            : normalizeInferenceSecretReference(value.secretReference);
    if (value.secretReference !== undefined && secretReference === undefined)
        return undefined;
    const normalizedEndpoint =
        typeof endpoint === 'string' ? endpoint : undefined;
    const normalizedExecutable =
        typeof executable === 'string' ? executable : undefined;
    const normalizedCapabilities = capabilities as InferenceCapabilityData[];
    const isLocalEmbeddings = provider === 'local-embeddings';
    const isConstrainedLocalGeneration = !isRemote && !isLocalEmbeddings;
    if (
        (isLocalEmbeddings && normalizedCapabilities.includes('generation')) ||
        (isConstrainedLocalGeneration &&
            normalizedCapabilities.includes('embeddings')) ||
        (enabled &&
            (modelId === undefined ||
                (!isLocalEmbeddings && secretReference === undefined)))
    )
        return undefined;
    return {
        id,
        label,
        provider: provider as InferenceProviderKindData,
        enabled,
        capabilities: normalizedCapabilities,
        ...(modelId === undefined ? {} : { modelId }),
        ...(normalizedEndpoint === undefined
            ? {}
            : { endpoint: normalizedEndpoint }),
        ...(normalizedExecutable === undefined
            ? {}
            : { executable: normalizedExecutable }),
        ...(secretReference === undefined ? {} : { secretReference }),
    };
};

const normalizeInferenceProfiles = (value: unknown): InferenceProfileData[] => {
    if (!Array.isArray(value) || value.length > 32) return [];
    const profiles: InferenceProfileData[] = [];
    const ids = new Set<string>();
    for (const item of value) {
        const profile = normalizeInferenceProfile(item);
        if (profile === undefined || ids.has(profile.id)) return [];
        ids.add(profile.id);
        profiles.push(profile);
    }
    return profiles;
};

const normalizeWorkspaceInferenceDefault = (
    value: unknown,
    profiles: ReadonlyArray<InferenceProfileData>,
): WorkspaceInferenceDefaultsData | undefined => {
    if (!isRecord(value)) return undefined;
    const profile = (id: unknown, capability: InferenceCapabilityData) => {
        if (id === undefined) return undefined;
        if (typeof id !== 'string') return null;
        return (
            profiles.find(
                candidate =>
                    candidate.id === id &&
                    candidate.enabled &&
                    candidate.capabilities.includes(capability),
            ) ?? null
        );
    };
    const generation = profile(value.generationProfileId, 'generation');
    const embedding = profile(value.embeddingProfileId, 'embeddings');
    if (generation === null || embedding === null) return undefined;
    return {
        ...(generation === undefined
            ? {}
            : { generationProfileId: generation.id }),
        ...(embedding === undefined
            ? {}
            : { embeddingProfileId: embedding.id }),
    };
};

const sanitizeWorkspaceInferenceDefault = (
    value: unknown,
    profiles: ReadonlyArray<InferenceProfileData>,
): WorkspaceInferenceDefaultsData | undefined => {
    if (!isRecord(value)) return undefined;
    const selected = (id: unknown, capability: InferenceCapabilityData) =>
        typeof id === 'string'
            ? profiles.find(
                  profile =>
                      profile.id === id &&
                      profile.enabled &&
                      profile.capabilities.includes(capability),
              )
            : undefined;
    const generation = selected(value.generationProfileId, 'generation');
    const embedding = selected(value.embeddingProfileId, 'embeddings');
    return {
        ...(generation === undefined
            ? {}
            : { generationProfileId: generation.id }),
        ...(embedding === undefined
            ? {}
            : { embeddingProfileId: embedding.id }),
    };
};

const sanitizeWorkspaceInferenceDefaults = (
    value: unknown,
    profiles: ReadonlyArray<InferenceProfileData>,
): Record<string, WorkspaceInferenceDefaultsData> => {
    if (!isRecord(value)) return {};
    return Object.fromEntries(
        Object.entries(value).flatMap(([engagementId, defaults]) => {
            const normalized = sanitizeWorkspaceInferenceDefault(
                defaults,
                profiles,
            );
            return normalized === undefined ? [] : [[engagementId, normalized]];
        }),
    );
};

const toRecentRepo = (entry: RecentRepoEntry): RecentRepo =>
    new RecentRepo({
        path: entry.path,
        name: entry.name,
        repoId: RepoIdBrand.make(entry.repoId),
        lastOpenedAt: entry.lastOpenedAt,
    });

const toChangeSetPullRequestEntry = (
    item: ChangeSetPullRequest,
): ChangeSetPullRequestEntry => ({
    repoId: item.repoId,
    repository: item.repository,
    number: item.number,
    title: item.title,
    url: item.url,
    headRefName: item.headRefName,
    headRefOid: item.headRefOid,
    baseRefName: item.baseRefName,
    dependencyNote: item.dependencyNote,
});

const scrubChangeSetRepo = (
    changeSets: ReadonlyArray<PullRequestChangeSetEntry>,
    repoId: RepoId,
): ReadonlyArray<PullRequestChangeSetEntry> =>
    changeSets.map(changeSet => {
        const pullRequests = changeSet.pullRequests.filter(
            item => item.repoId !== repoId,
        );
        return pullRequests.length === changeSet.pullRequests.length
            ? changeSet
            : { ...changeSet, pullRequests, updatedAt: Date.now() };
    });

/** Materialize the wire snapshot while enforcing the no-cross-engagement ownership rule. */
const toEngagementWorkspace = (config: Config): EngagementWorkspace => {
    const reposById = new Map(
        config.recentRepos.map(repo => [repo.repoId, repo] as const),
    );
    const assigned = new Set<string>();
    const engagements = config.engagements.map(entry => {
        const repositoryEntries = entry.repoIds
            .filter(repoId => reposById.has(repoId) && !assigned.has(repoId))
            .map(repoId => {
                assigned.add(repoId);
                return reposById.get(repoId)!;
            });
        const memberIds = new Set(repositoryEntries.map(repo => repo.repoId));
        const openRepoIds = entry.openRepoIds
            .filter(repoId => memberIds.has(repoId))
            .map(repoId => RepoIdBrand.make(repoId));
        const activeRepoId =
            entry.activeRepoId !== undefined &&
            openRepoIds.includes(RepoIdBrand.make(entry.activeRepoId))
                ? RepoIdBrand.make(entry.activeRepoId)
                : undefined;
        return new Engagement({
            id: EngagementIdBrand.make(entry.id),
            name: entry.name,
            slug: EngagementSlugBrand.make(entry.slug),
            color: entry.color,
            avatarUrl: entry.avatarUrl,
            repositories: repositoryEntries.map(toRecentRepo),
            openRepoIds,
            activeRepoId,
            changeSets: entry.changeSets.map(
                changeSet =>
                    new PullRequestChangeSet({
                        id: ChangeSetIdBrand.make(changeSet.id),
                        name: changeSet.name,
                        description: changeSet.description,
                        pullRequests: changeSet.pullRequests
                            .filter(item => memberIds.has(item.repoId))
                            .map(
                                item =>
                                    new ChangeSetPullRequestSchema({
                                        repoId: RepoIdBrand.make(item.repoId),
                                        repository: item.repository,
                                        number: item.number,
                                        title: item.title,
                                        url: item.url,
                                        headRefName: item.headRefName,
                                        headRefOid:
                                            item.headRefOid === undefined
                                                ? undefined
                                                : OidBrand.make(
                                                      item.headRefOid,
                                                  ),
                                        baseRefName: item.baseRefName,
                                        dependencyNote: item.dependencyNote,
                                    }),
                            ),
                        createdAt: changeSet.createdAt,
                        updatedAt: changeSet.updatedAt,
                    }),
            ),
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
        });
    });
    const engagementIds = new Set(engagements.map(engagement => engagement.id));
    return new EngagementWorkspace({
        engagements,
        activeEngagementId:
            config.activeEngagementId !== undefined &&
            engagementIds.has(EngagementIdBrand.make(config.activeEngagementId))
                ? EngagementIdBrand.make(config.activeEngagementId)
                : undefined,
        unassignedRepositories: config.recentRepos
            .filter(repo => !assigned.has(repo.repoId))
            .map(toRecentRepo),
    });
};

/** Column visibility: each known flag is a boolean if present, else defaults to shown. */
const normalizeColumns = (value: unknown): HistoryColumns => {
    const obj =
        typeof value === 'object' && value !== null
            ? (value as Record<string, unknown>)
            : {};
    const flag = (key: keyof HistoryColumns): boolean =>
        typeof obj[key] === 'boolean'
            ? (obj[key] as boolean)
            : DEFAULT_COLUMNS[key];
    return {
        authorName: flag('authorName'),
        avatar: flag('avatar'),
        date: flag('date'),
        sha: flag('sha'),
    };
};

const normalizeRecents = (value: unknown): RecentRepoEntry[] => {
    if (!Array.isArray(value)) return [];
    const out: RecentRepoEntry[] = [];
    for (const item of value) {
        if (typeof item !== 'object' || item === null) continue;
        const e = item as Record<string, unknown>;
        if (
            typeof e.path === 'string' &&
            typeof e.name === 'string' &&
            typeof e.repoId === 'string' &&
            typeof e.lastOpenedAt === 'number'
        ) {
            out.push({
                path: e.path,
                name: e.name,
                repoId: e.repoId,
                lastOpenedAt: e.lastOpenedAt,
            });
        }
    }
    return out;
};

const ENGAGEMENT_COLORS = new Set<EngagementColor>([
    'teal',
    'blue',
    'violet',
    'amber',
    'rose',
    'slate',
]);

const normalizeAvatarUrl = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const avatarUrl = value.trim();
    if (avatarUrl === '' || avatarUrl.length > 2048) return undefined;
    if (localAvatarUrlPattern.test(avatarUrl)) return avatarUrl;
    try {
        const parsed = new URL(avatarUrl);
        if (
            (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
            parsed.username !== '' ||
            parsed.password !== ''
        )
            return undefined;
        return parsed.href;
    } catch {
        return undefined;
    }
};

const normalizeEngagements = (value: unknown): EngagementEntry[] => {
    if (!Array.isArray(value)) return [];
    const result: EngagementEntry[] = [];
    const seenIds = new Set<string>();
    const seenSlugs = new Set<string>();
    const assignedRepoIds = new Set<string>();
    for (const item of value) {
        if (typeof item !== 'object' || item === null) continue;
        const entry = item as Record<string, unknown>;
        if (
            typeof entry.id !== 'string' ||
            entry.id === '' ||
            seenIds.has(entry.id) ||
            typeof entry.name !== 'string' ||
            entry.name.trim() === '' ||
            !ENGAGEMENT_COLORS.has(entry.color as EngagementColor)
        )
            continue;
        seenIds.add(entry.id);
        const repoIds = stringArray(entry.repoIds).filter(repoId => {
            if (assignedRepoIds.has(repoId)) return false;
            assignedRepoIds.add(repoId);
            return true;
        });
        const members = new Set(repoIds);
        const openRepoIds = stringArray(entry.openRepoIds).filter(repoId =>
            members.has(repoId),
        );
        const activeRepoId =
            typeof entry.activeRepoId === 'string' &&
            openRepoIds.includes(entry.activeRepoId)
                ? entry.activeRepoId
                : undefined;
        const name = entry.name.trim();
        const configuredSlug =
            typeof entry.slug === 'string'
                ? validEngagementSlug(entry.slug)
                : undefined;
        const slug =
            configuredSlug !== undefined && !seenSlugs.has(configuredSlug)
                ? configuredSlug
                : uniqueEngagementSlug(slugFromName(name), seenSlugs);
        seenSlugs.add(slug);
        result.push({
            id: entry.id,
            name,
            slug,
            color: entry.color as EngagementColor,
            avatarUrl: normalizeAvatarUrl(entry.avatarUrl),
            repoIds,
            openRepoIds,
            activeRepoId,
            changeSets: normalizeChangeSets(entry.changeSets, members),
            createdAt:
                typeof entry.createdAt === 'number' ? entry.createdAt : 0,
            updatedAt:
                typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
        });
    }
    return result;
};

const normalizeChangeSets = (
    value: unknown,
    members: ReadonlySet<string>,
): PullRequestChangeSetEntry[] => {
    if (!Array.isArray(value)) return [];
    const result: PullRequestChangeSetEntry[] = [];
    const ids = new Set<string>();
    for (const item of value) {
        if (typeof item !== 'object' || item === null) continue;
        const entry = item as Record<string, unknown>;
        if (
            typeof entry.id !== 'string' ||
            entry.id === '' ||
            ids.has(entry.id) ||
            typeof entry.name !== 'string' ||
            entry.name.trim() === ''
        )
            continue;
        ids.add(entry.id);
        result.push({
            id: entry.id,
            name: entry.name.trim(),
            description:
                typeof entry.description === 'string' ? entry.description : '',
            pullRequests: normalizeChangeSetPullRequests(
                entry.pullRequests,
                members,
            ),
            createdAt:
                typeof entry.createdAt === 'number' ? entry.createdAt : 0,
            updatedAt:
                typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
        });
    }
    return result;
};

const normalizeChangeSetPullRequests = (
    value: unknown,
    members: ReadonlySet<string>,
): ChangeSetPullRequestEntry[] => {
    if (!Array.isArray(value)) return [];
    const result: ChangeSetPullRequestEntry[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        if (typeof item !== 'object' || item === null) continue;
        const entry = item as Record<string, unknown>;
        if (
            typeof entry.repoId !== 'string' ||
            !members.has(entry.repoId) ||
            typeof entry.repository !== 'string' ||
            typeof entry.number !== 'number' ||
            !Number.isFinite(entry.number) ||
            typeof entry.title !== 'string' ||
            typeof entry.url !== 'string' ||
            typeof entry.headRefName !== 'string' ||
            typeof entry.baseRefName !== 'string'
        )
            continue;
        const key = `${entry.repoId}\0${entry.number}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({
            repoId: entry.repoId,
            repository: entry.repository,
            number: entry.number,
            title: entry.title,
            url: entry.url,
            headRefName: entry.headRefName,
            headRefOid:
                typeof entry.headRefOid === 'string'
                    ? entry.headRefOid
                    : undefined,
            baseRefName: entry.baseRefName,
            dependencyNote:
                typeof entry.dependencyNote === 'string'
                    ? entry.dependencyNote
                    : '',
        });
    }
    return result;
};

const stringArray = (value: unknown): string[] =>
    Array.isArray(value)
        ? [...new Set(value.filter(item => typeof item === 'string'))]
        : [];

const normalizeBind = (
    value: unknown,
    fallback: Config['bind'],
): Config['bind'] => {
    if (typeof value !== 'object' || value === null) return fallback;
    const b = value as Record<string, unknown>;
    return {
        address: typeof b.address === 'string' ? b.address : fallback.address,
        port: typeof b.port === 'number' ? b.port : fallback.port,
    };
};

const isLogLevel = (v: unknown): v is Config['logLevel'] =>
    v === 'error' || v === 'warn' || v === 'info' || v === 'debug';

const pickNumbers = (value: unknown): Record<string, number> => {
    if (typeof value !== 'object' || value === null) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(value))
        if (typeof v === 'number') out[k] = v;
    return out;
};

const pickStrings = (value: unknown): Record<string, string> => {
    if (typeof value !== 'object' || value === null) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value))
        if (typeof v === 'string') out[k] = v;
    return out;
};
