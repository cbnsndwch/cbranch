import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RecentRepo, RepoId } from '@cbranch/rpc-contract';
import { describe, expect, test } from 'vitest';

import { run } from '../testing/effect-run';
import {
    ENGAGEMENT_DIRECTORY_SCAN_LIMIT,
    FILESYSTEM_LIST_LIMIT,
    filesystemRootCandidates,
    listFilesystemDirectory,
    scanFilesystemDirectory,
} from './list-directory';

describe('listFilesystemDirectory', () => {
    test('lists immediate entries inside host-selected roots and hides dotfiles by default', async () => {
        const root = mkdtempSync(join(tmpdir(), 'cbranch-fs-picker-'));
        mkdirSync(join(root, 'repo', '.git'), { recursive: true });
        mkdirSync(join(root, 'folder'));
        writeFileSync(join(root, 'visible.txt'), 'visible');
        writeFileSync(join(root, '.hidden'), 'hidden');

        const listing = await run(
            listFilesystemDirectory({}, [{ label: 'Fixture', path: root }]),
        );
        expect(listing.path).toBe(root);
        expect(listing.parent).toBeNull();
        expect(listing.entries.map(entry => entry.name)).toEqual([
            'folder',
            'repo',
            'visible.txt',
        ]);
        expect(
            listing.entries.find(entry => entry.name === 'repo'),
        ).toMatchObject({
            kind: 'dir',
            isRepository: true,
            navigable: true,
        });

        const withHidden = await run(
            listFilesystemDirectory({ path: root, showHidden: true }, [
                { label: 'Fixture', path: root },
            ]),
        );
        expect(withHidden.entries.map(entry => entry.name)).toContain(
            '.hidden',
        );
    });

    test('rejects paths outside the host-selected roots and marks escaping symlinks non-navigable', async () => {
        const root = mkdtempSync(join(tmpdir(), 'cbranch-fs-picker-root-'));
        const outside = mkdtempSync(
            join(tmpdir(), 'cbranch-fs-picker-outside-'),
        );
        symlinkSync(outside, join(root, 'outside-link'));

        await expect(
            run(
                listFilesystemDirectory({ path: outside }, [
                    { label: 'Fixture', path: root },
                ]),
            ),
        ).rejects.toMatchObject({ code: 'permissionDenied' });
        const listing = await run(
            listFilesystemDirectory({}, [{ label: 'Fixture', path: root }]),
        );
        expect(
            listing.entries.find(entry => entry.name === 'outside-link'),
        ).toMatchObject({ kind: 'symlink', navigable: false });
    });

    test('adds recent-repository parents as picker roots', () => {
        const recent = new RecentRepo({
            path: '/work/client/api',
            name: 'api',
            repoId: RepoId.make('a'.repeat(64)),
            lastOpenedAt: 1,
        });
        const roots = filesystemRootCandidates([recent], {
            CBRANCH_FS_ROOTS: '/shared',
        });
        expect(roots).toContainEqual({ label: 'shared', path: '/shared' });
        expect(roots).toContainEqual({ label: 'client', path: '/work/client' });
    });

    test('caps large directories', async () => {
        const root = mkdtempSync(join(tmpdir(), 'cbranch-fs-picker-cap-'));
        for (let index = 0; index <= FILESYSTEM_LIST_LIMIT; index++)
            writeFileSync(join(root, `file-${index}`), 'x');
        const listing = await run(
            listFilesystemDirectory({}, [{ label: 'Fixture', path: root }]),
        );
        expect(listing.entries).toHaveLength(FILESYSTEM_LIST_LIMIT);
        expect(listing.truncated).toBe(true);
    });

    test('ignores hidden entries when determining a default listing truncation', async () => {
        const root = mkdtempSync(
            join(tmpdir(), 'cbranch-fs-picker-hidden-cap-'),
        );
        for (let index = 0; index < FILESYSTEM_LIST_LIMIT; index++)
            writeFileSync(join(root, `file-${index}`), 'x');
        writeFileSync(join(root, '.hidden'), 'hidden');

        const listing = await run(
            listFilesystemDirectory({}, [{ label: 'Fixture', path: root }]),
        );
        expect(listing.entries).toHaveLength(FILESYSTEM_LIST_LIMIT);
        expect(listing.truncated).toBe(false);
    });

    test('scans only sorted, immediate real directories for workspace imports', async () => {
        const root = mkdtempSync(join(tmpdir(), 'cbranch-fs-import-'));
        mkdirSync(join(root, 'zebra'));
        mkdirSync(join(root, 'alpha'));
        mkdirSync(join(root, '.hidden'));
        symlinkSync(join(root, 'alpha'), join(root, 'linked-alpha'));
        for (let index = 0; index <= ENGAGEMENT_DIRECTORY_SCAN_LIMIT; index++)
            mkdirSync(join(root, `repo-${index}`));

        const scan = await run(
            scanFilesystemDirectory(root, [{ label: 'Fixture', path: root }]),
        );
        expect(scan.entries).toHaveLength(ENGAGEMENT_DIRECTORY_SCAN_LIMIT);
        expect(scan.entries.map(entry => entry.name)).toEqual(
            scan.entries.map(entry => entry.name).toSorted(),
        );
        expect(scan.entries.map(entry => entry.name)).not.toContain('.hidden');
        expect(scan.entries.map(entry => entry.name)).not.toContain(
            'linked-alpha',
        );
        expect(scan.truncated).toBe(true);
    });
});
