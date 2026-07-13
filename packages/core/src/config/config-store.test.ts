import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
    ChangeSetPullRequest,
    EngagementId,
    EngagementSlug,
    Oid,
    RecentRepo,
    RepoId,
} from '@cbranch/rpc-contract';
import { afterAll, describe, expect, test } from 'vitest';

import { run } from '../testing/effect-run';
import {
    CONFIG_VERSION,
    defaultConfig,
    DEFAULT_BIND,
    DEFAULT_THRESHOLDS,
    makeConfigStore,
    resolveConfigPath,
} from './config-store';

const tmp = mkdtempSync(join(tmpdir(), 'cbranch-config-'));
let counter = 0;
const newPath = (): string => join(tmp, `config-${counter++}.json`);

afterAll(() => {
    // best-effort: leave temp dir to the OS; files are tiny.
});

describe('defaults (NF-CFG-5/7)', () => {
    test('a missing file loads documented defaults without crashing', async () => {
        const store = makeConfigStore({ configPath: newPath() });
        const config = await run(store.load());
        expect(config.version).toBe(CONFIG_VERSION);
        expect(config.recentRepos).toEqual([]);
        expect(config.engagements).toEqual([]);
        expect(config.theme).toBe('system');
        expect(config.bind).toEqual(DEFAULT_BIND);
        expect(config.thresholds.logPageSize).toBe(
            DEFAULT_THRESHOLDS.logPageSize,
        );
    });

    test('garbage JSON falls back to defaults', async () => {
        const path = newPath();
        writeFileSync(path, '{ not valid json', 'utf8');
        const config = await run(makeConfigStore({ configPath: path }).load());
        expect(config).toEqual(defaultConfig());
    });

    test('unknown fields are ignored; known fields are kept (migration-safe)', async () => {
        const path = newPath();
        writeFileSync(
            path,
            JSON.stringify({
                version: 999,
                theme: 'dark',
                locale: 'fr',
                somethingUnknown: { a: 1 },
                bind: { address: '0.0.0.0', port: 9999, extra: true },
                recentRepos: [
                    {
                        path: '/r',
                        name: 'r',
                        repoId: 'a'.repeat(64),
                        lastOpenedAt: 1,
                    },
                    { path: '/bad' }, // dropped: missing required fields
                ],
            }),
            'utf8',
        );
        const config = await run(makeConfigStore({ configPath: path }).load());
        expect(config.theme).toBe('dark');
        expect(config.locale).toBe('fr');
        expect(config.bind).toEqual({ address: '0.0.0.0', port: 9999 });
        expect(config.recentRepos).toHaveLength(1);
        expect('somethingUnknown' in config).toBe(false);
    });

    test('normalizes malformed v2 change-set data without crossing membership', async () => {
        const path = newPath();
        const repoId = 'a'.repeat(64);
        const validPull = {
            repoId,
            repository: 'acme/api',
            number: 12,
            title: 'API change',
            url: 'https://github.com/acme/api/pull/12',
            headRefName: 'feature/api',
            baseRefName: 'main',
        };
        writeFileSync(
            path,
            JSON.stringify({
                version: 2,
                recentRepos: [
                    {
                        path: '/api',
                        name: 'api',
                        repoId,
                        lastOpenedAt: 1,
                    },
                ],
                engagements: [
                    null,
                    { id: '', name: 'bad', color: 'teal' },
                    {
                        id: 'client',
                        name: ' Client ',
                        color: 'blue',
                        repoIds: [repoId],
                        openRepoIds: [repoId, 'outside'],
                        activeRepoId: 'outside',
                        changeSets: [
                            null,
                            {
                                id: 'release',
                                name: ' Release ',
                                pullRequests: [
                                    null,
                                    validPull,
                                    validPull,
                                    { ...validPull, repoId: 'outside' },
                                    { ...validPull, number: '12' },
                                ],
                            },
                            { id: 'release', name: 'duplicate' },
                            { id: 'empty', name: ' ' },
                        ],
                    },
                    {
                        id: 'client',
                        name: 'duplicate engagement',
                        color: 'rose',
                    },
                ],
            }),
            'utf8',
        );

        const workspace = await run(
            makeConfigStore({ configPath: path }).listEngagements(),
        );
        expect(workspace.engagements).toHaveLength(1);
        expect(workspace.engagements[0]?.name).toBe('Client');
        expect(workspace.engagements[0]?.slug).toBe('client');
        expect(workspace.engagements[0]?.openRepoIds).toEqual([repoId]);
        expect(workspace.engagements[0]?.activeRepoId).toBeUndefined();
        expect(workspace.engagements[0]?.changeSets).toHaveLength(1);
        expect(workspace.engagements[0]?.changeSets[0]).toMatchObject({
            name: 'Release',
            description: '',
            createdAt: 0,
            updatedAt: 0,
        });
        expect(
            workspace.engagements[0]?.changeSets[0]?.pullRequests,
        ).toHaveLength(1);
    });
});

describe('engagement workspaces', () => {
    test('generates unique URL slugs, preserves them on rename, and persists edits', async () => {
        const path = newPath();
        const store = makeConfigStore({ configPath: path });
        const first = await run(store.createEngagement('Client A', 'teal'));
        const second = await run(store.createEngagement('Client A', 'blue'));
        const firstId = first.engagements[0]!.id;
        const secondId = second.engagements[1]!.id;

        expect(first.engagements[0]?.slug).toBe('client-a');
        expect(second.engagements[1]?.slug).toBe('client-a-2');
        await run(store.updateEngagement(firstId, { name: 'Renamed client' }));
        await run(
            store.updateEngagement(firstId, {
                slug: EngagementSlug.make('acme-platform'),
            }),
        );

        await expect(
            run(
                store.updateEngagement(secondId, {
                    slug: EngagementSlug.make('acme-platform'),
                }),
            ),
        ).rejects.toMatchObject({ code: 'gitFailed' });
        await expect(
            run(
                store.createEngagement(
                    'Invalid slug',
                    'rose',
                    undefined,
                    EngagementSlug.make('Not valid'),
                ),
            ),
        ).rejects.toMatchObject({ code: 'gitFailed' });

        const reread = await run(
            makeConfigStore({ configPath: path }).listEngagements(),
        );
        expect(reread.engagements[0]).toMatchObject({
            name: 'Renamed client',
            slug: 'acme-platform',
        });
        expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(
            CONFIG_VERSION,
        );
    });

    test('persists isolated membership and ordered open-repo sessions', async () => {
        const path = newPath();
        const store = makeConfigStore({ configPath: path });
        const a = entry('/client-a/api');
        const b = entry('/client-a/web');
        await run(store.upsertRecent(a));
        await run(store.upsertRecent(b));

        const created = await run(store.createEngagement('Client A', 'teal'));
        const engagementId = created.engagements[0]!.id;
        await run(
            store.assignEngagementRepo(engagementId, RepoId.make(a.repoId)),
        );
        await run(
            store.assignEngagementRepo(engagementId, RepoId.make(b.repoId)),
        );
        await run(
            store.setEngagementSession(
                engagementId,
                [RepoId.make(b.repoId), RepoId.make(a.repoId)],
                RepoId.make(a.repoId),
            ),
        );

        const reread = await run(
            makeConfigStore({ configPath: path }).listEngagements(),
        );
        expect(reread.activeEngagementId).toBe(engagementId);
        expect(
            reread.engagements[0]?.repositories.map(repo => repo.path),
        ).toEqual(['/client-a/api', '/client-a/web']);
        expect(reread.engagements[0]?.openRepoIds).toEqual([
            b.repoId,
            a.repoId,
        ]);
        expect(reread.engagements[0]?.activeRepoId).toBe(a.repoId);
        expect(reread.unassignedRepositories).toEqual([]);
    });

    test('persists, clears, and validates workspace avatar URLs', async () => {
        const path = newPath();
        const store = makeConfigStore({ configPath: path });
        const created = await run(
            store.createEngagement(
                'Client A',
                'teal',
                'https://avatars.example.test/client-a.png',
            ),
        );
        const id = created.engagements[0]!.id;
        expect(created.engagements[0]?.avatarUrl).toBe(
            'https://avatars.example.test/client-a.png',
        );

        await expect(
            run(
                store.updateEngagement(id, { avatarUrl: 'file:///secret.png' }),
            ),
        ).rejects.toMatchObject({ code: 'gitFailed' });

        await run(store.updateEngagement(id, { avatarUrl: null }));
        const reread = await run(
            makeConfigStore({ configPath: path }).listEngagements(),
        );
        expect(reread.engagements[0]?.avatarUrl).toBeUndefined();
    });

    test('persists uploaded workspace avatars beside the config and removes them', async () => {
        const path = newPath();
        const store = makeConfigStore({ configPath: path });
        const created = await run(store.createEngagement('Client A', 'teal'));
        const id = created.engagements[0]!.id;
        const png = new Uint8Array([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);

        await expect(
            run(store.uploadEngagementAvatar(id, new Uint8Array([0x00]))),
        ).rejects.toMatchObject({ code: 'gitFailed' });

        const uploaded = await run(store.uploadEngagementAvatar(id, png));
        expect(uploaded.avatarUrl).toMatch(
            /^\/sidechannel\/workspace-avatar\/[a-f0-9]{64}\.png\?v=/,
        );
        const filename = uploaded.avatarUrl
            .replace('/sidechannel/workspace-avatar/', '')
            .split('?')[0]!;
        expect(
            readFileSync(join(dirname(path), 'workspace-avatars', filename)),
        ).toEqual(Buffer.from(png));

        const loaded = await run(store.readEngagementAvatar(filename));
        expect(loaded).toMatchObject({
            bytes: png,
            contentType: 'image/png',
        });
        const workspace = await run(store.listEngagements());
        expect(workspace.engagements[0]?.avatarUrl).toBe(uploaded.avatarUrl);

        await run(store.removeEngagementAvatar(id));
        expect(await run(store.readEngagementAvatar(filename))).toBeUndefined();
        expect(
            (await run(store.listEngagements())).engagements[0]?.avatarUrl,
        ).toBeUndefined();
    });

    test('moving a repo between engagements is exclusive and deleting unassigns it', async () => {
        const store = makeConfigStore({ configPath: newPath() });
        const repo = entry('/shared-looking-but-owned');
        await run(store.upsertRecent(repo));
        const first = await run(store.createEngagement('Client A', 'blue'));
        const firstId = first.engagements[0]!.id;
        const second = await run(store.createEngagement('Client B', 'rose'));
        const secondId = second.engagements[1]!.id;
        await run(
            store.assignEngagementRepo(firstId, RepoId.make(repo.repoId)),
        );
        const moved = await run(
            store.assignEngagementRepo(secondId, RepoId.make(repo.repoId)),
        );
        expect(moved.engagements[0]?.repositories).toEqual([]);
        expect(moved.engagements[1]?.repositories[0]?.repoId).toBe(repo.repoId);

        const deleted = await run(store.deleteEngagement(secondId));
        expect(deleted.unassignedRepositories[0]?.repoId).toBe(repo.repoId);
        expect(deleted.activeEngagementId).toBe(firstId);
    });

    test('persists workspace order and rejects incomplete or duplicate orders', async () => {
        const path = newPath();
        const store = makeConfigStore({ configPath: path });
        const first = await run(store.createEngagement('First', 'teal'));
        const second = await run(store.createEngagement('Second', 'blue'));
        const third = await run(store.createEngagement('Third', 'rose'));
        const ids = [
            first.engagements[0]!.id,
            second.engagements[1]!.id,
            third.engagements[2]!.id,
        ];

        const reordered = await run(
            store.reorderEngagements([ids[2]!, ids[0]!, ids[1]!]),
        );
        expect(
            reordered.engagements.map(engagement => engagement.name),
        ).toEqual(['Third', 'First', 'Second']);
        expect(
            (
                await run(
                    makeConfigStore({ configPath: path }).listEngagements(),
                )
            ).engagements.map(engagement => engagement.id),
        ).toEqual([ids[2], ids[0], ids[1]]);

        await expect(
            run(store.reorderEngagements([ids[0]!, ids[0]!, ids[1]!])),
        ).rejects.toMatchObject({ code: 'gitFailed' });
    });

    test('rejects session repos outside the engagement boundary', async () => {
        const store = makeConfigStore({ configPath: newPath() });
        const created = await run(store.createEngagement('Client', 'amber'));
        const id = EngagementId.make(created.engagements[0]!.id);
        await expect(
            run(
                store.setEngagementSession(
                    id,
                    [RepoId.make('unassigned')],
                    RepoId.make('unassigned'),
                ),
            ),
        ).rejects.toMatchObject({ code: 'repoUnavailable' });
    });

    test('persists ordered PR change sets and keeps them inside membership', async () => {
        const path = newPath();
        const store = makeConfigStore({ configPath: path });
        const api = entry('/client/api');
        const web = entry('/client/web');
        const outside = entry('/other/repo');
        await run(store.upsertRecent(api));
        await run(store.upsertRecent(web));
        await run(store.upsertRecent(outside));
        const created = await run(store.createEngagement('Client', 'violet'));
        const id = created.engagements[0]!.id;
        await run(store.assignEngagementRepo(id, RepoId.make(api.repoId)));
        await run(store.assignEngagementRepo(id, RepoId.make(web.repoId)));
        const withSet = await run(
            store.createChangeSet(id, 'Release train', 'API before web'),
        );
        const changeSetId = withSet.engagements[0]!.changeSets[0]!.id;
        const items = [
            changeSetItem(web.repoId, 'client/web', 22),
            changeSetItem(api.repoId, 'client/api', 11),
        ];
        await run(store.setChangeSetItems(id, changeSetId, items));
        await run(
            store.updateChangeSet(id, changeSetId, {
                description: 'Deploy API, then web',
            }),
        );

        const reread = await run(
            makeConfigStore({ configPath: path }).listEngagements(),
        );
        expect(
            reread.engagements[0]?.changeSets[0]?.pullRequests.map(
                item => item.number,
            ),
        ).toEqual([22, 11]);
        expect(reread.engagements[0]?.changeSets[0]?.description).toBe(
            'Deploy API, then web',
        );

        await expect(
            run(
                store.setChangeSetItems(id, changeSetId, [
                    changeSetItem(outside.repoId, 'other/repo', 7),
                ]),
            ),
        ).rejects.toMatchObject({ code: 'repoUnavailable' });
    });

    test('moving a repository scrubs its PRs from the old engagement change sets', async () => {
        const store = makeConfigStore({ configPath: newPath() });
        const repo = entry('/client/api');
        await run(store.upsertRecent(repo));
        const first = await run(store.createEngagement('First', 'teal'));
        const firstId = first.engagements[0]!.id;
        const second = await run(store.createEngagement('Second', 'blue'));
        const secondId = second.engagements[1]!.id;
        await run(
            store.assignEngagementRepo(firstId, RepoId.make(repo.repoId)),
        );
        const withSet = await run(store.createChangeSet(firstId, 'Migration'));
        const changeSetId = withSet.engagements[0]!.changeSets[0]!.id;
        await run(
            store.setChangeSetItems(firstId, changeSetId, [
                changeSetItem(repo.repoId, 'client/api', 1),
            ]),
        );

        const moved = await run(
            store.assignEngagementRepo(secondId, RepoId.make(repo.repoId)),
        );
        expect(moved.engagements[0]?.changeSets[0]?.pullRequests).toEqual([]);
    });
});

const changeSetItem = (repoId: string, repository: string, number: number) =>
    new ChangeSetPullRequest({
        repoId: RepoId.make(repoId),
        repository,
        number,
        title: `PR ${number}`,
        url: `https://github.com/${repository}/pull/${number}`,
        headRefName: `feature/${number}`,
        headRefOid: Oid.make(String(number).repeat(40).slice(0, 40)),
        baseRefName: 'main',
        dependencyNote: '',
    });

const entry = (p: string) => ({
    path: p,
    name: p.split('/').pop() ?? p,
    repoId: createHash('sha256').update(p).digest('hex'),
    lastOpenedAt: Date.now(),
});

describe('recent list CRUD (P1-RECENT-1/3/5)', () => {
    test('upsert moves to top + de-duplicates by path; list returns RecentRepo instances', async () => {
        const store = makeConfigStore({ configPath: newPath() });
        await run(store.upsertRecent(entry('/a')));
        await run(store.upsertRecent(entry('/b')));
        await run(store.upsertRecent(entry('/a'))); // re-open A → back to top, no dup
        const recents = await run(store.listRecent());
        expect(recents.map(r => r.path)).toEqual(['/a', '/b']);
        expect(recents[0]).toBeInstanceOf(RecentRepo);
    });

    test('remove + rename persist', async () => {
        const store = makeConfigStore({ configPath: newPath() });
        const a = entry('/a');
        const b = entry('/b');
        await run(store.upsertRecent(a));
        await run(store.upsertRecent(b));
        await run(store.removeRecent(RepoId.make(b.repoId)));
        await run(store.renameRecent(RepoId.make(a.repoId), 'Custom Name'));
        const recents = await run(store.listRecent());
        expect(recents).toHaveLength(1);
        expect(recents[0]?.name).toBe('Custom Name');
    });

    test('save normalizes the version field on disk', async () => {
        const path = newPath();
        const store = makeConfigStore({ configPath: path });
        await run(store.upsertRecent(entry('/a')));
        const written = JSON.parse(readFileSync(path, 'utf8')) as {
            version: number;
        };
        expect(written.version).toBe(CONFIG_VERSION);
    });
});

describe('app settings (REQ-P5-CFG-006; NEVER git config, REQ-P5-CFG-005)', () => {
    test('getAppSettings returns documented defaults on a missing file', async () => {
        const store = makeConfigStore({ configPath: newPath() });
        const settings = await run(store.getAppSettings());
        expect(settings.theme).toBe('system');
        expect(settings.locale).toBe('en');
        expect(settings.keybindings).toEqual({});
        // Every optional history column defaults to shown (REQ-P6-COL-002).
        expect(settings.columns).toEqual({
            authorName: true,
            avatar: true,
            date: true,
            sha: true,
        });
    });

    test('setAppSettings persists history column visibility (REQ-P6-COL-002)', async () => {
        const path = newPath();
        const store = makeConfigStore({ configPath: path });
        await run(
            store.setAppSettings({
                columns: {
                    authorName: true,
                    avatar: false,
                    date: false,
                    sha: true,
                },
            }),
        );
        const reread = await run(store.getAppSettings());
        expect(reread.columns).toEqual({
            authorName: true,
            avatar: false,
            date: false,
            sha: true,
        });
        // Other defaults are untouched by a columns-only patch.
        expect(reread.theme).toBe('system');
    });

    test('setAppSettings merges a partial patch + persists; defaults preserved', async () => {
        const path = newPath();
        const store = makeConfigStore({ configPath: path });
        const returned = await run(store.setAppSettings({ theme: 'dark' }));
        expect(returned.theme).toBe('dark');
        expect(returned.locale).toBe('en'); // untouched default preserved
        const reread = await run(store.getAppSettings());
        expect(reread.theme).toBe('dark');
        // theme/keybindings live in THIS file, not git config.
        expect(readFileSync(path, 'utf8')).toContain('"theme": "dark"');
    });

    test('setAppSettings round-trips keybindings and restamps the version', async () => {
        const path = newPath();
        const store = makeConfigStore({ configPath: path });
        await run(
            store.setAppSettings({
                keybindings: { 'commands.commit': 'Mod+Enter' },
                locale: 'fr',
            }),
        );
        const reread = await run(store.getAppSettings());
        expect(reread.keybindings).toEqual({ 'commands.commit': 'Mod+Enter' });
        expect(reread.locale).toBe('fr');
        const written = JSON.parse(readFileSync(path, 'utf8')) as {
            version: number;
        };
        expect(written.version).toBe(CONFIG_VERSION);
    });
});

describe('concurrent writes are serialized (no lost update)', () => {
    test('a theme save racing an upsertRecent: both persist', async () => {
        const store = makeConfigStore({ configPath: newPath() });
        const e = entry('/a');
        // Without serialization both writers load the same base, then each saves its
        // OWN full config, so the later write clobbers the earlier (lost update). The
        // module-level write permit makes the read→modify→write atomic.
        await Promise.all([
            run(store.setAppSettings({ theme: 'dark' })),
            run(store.upsertRecent(e)),
        ]);
        const config = await run(store.load());
        expect(config.theme).toBe('dark');
        expect(config.recentRepos.map(r => r.path)).toEqual(['/a']);
    });

    test('many concurrent upserts all persist', async () => {
        const store = makeConfigStore({ configPath: newPath() });
        const paths = Array.from({ length: 10 }, (_, i) => `/r${i}`);
        await Promise.all(paths.map(p => run(store.upsertRecent(entry(p)))));
        const recents = await run(store.listRecent());
        expect(recents.map(r => r.path).toSorted()).toEqual(
            [...paths].toSorted(),
        );
    });
});

describe('resolveConfigPath (NF-CFG-7 / NF-PKG-9 precedence)', () => {
    test('CBRANCH_CONFIG wins', () => {
        expect(
            resolveConfigPath({
                CBRANCH_CONFIG: '/custom/c.json',
            } as NodeJS.ProcessEnv),
        ).toBe('/custom/c.json');
    });

    test('falls back to a cbranch/config.json under a config home', () => {
        const resolved = resolveConfigPath({
            XDG_CONFIG_HOME: '/xdg',
            APPDATA: '/appdata',
        } as NodeJS.ProcessEnv);
        expect(resolved.replace(/\\/g, '/')).toContain('cbranch/config.json');
    });
});
