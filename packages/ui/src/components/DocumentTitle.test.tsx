// @vitest-environment jsdom

import {
    Engagement,
    EngagementId,
    EngagementSlug,
    EngagementWorkspace,
    RecentRepo,
    RepoId,
} from '@cbranch/rpc-contract';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { DocumentTitle } from './DocumentTitle';
import { useUiStore } from '../state/store';

const mocks = vi.hoisted(() => ({
    setDesktopWindowTitle: vi.fn(async () => undefined),
    useEngagementWorkspace: vi.fn(),
}));

vi.mock('../desktop/bridge', () => ({
    setDesktopWindowTitle: mocks.setDesktopWindowTitle,
}));

vi.mock('../rpc/hooks', () => ({
    useEngagementWorkspace: mocks.useEngagementWorkspace,
}));

const engagementId = EngagementId.make('client-a');
const repoId = RepoId.make('repo-api');
const unassignedRepoId = RepoId.make('repo-tools');
const api = new RecentRepo({
    repoId,
    name: 'api',
    path: '/repos/api',
    lastOpenedAt: 1,
});
const tools = new RecentRepo({
    repoId: unassignedRepoId,
    name: 'tools',
    path: '/repos/tools',
    lastOpenedAt: 1,
});
const client = new Engagement({
    id: engagementId,
    name: 'Client A',
    slug: EngagementSlug.make('client-a'),
    color: 'teal',
    repositories: [api],
    openRepoIds: [repoId],
    activeRepoId: repoId,
    changeSets: [],
    createdAt: 1,
    updatedAt: 1,
});

const setContext = (
    workspace: EngagementWorkspace | undefined,
    activeEngagementId: EngagementId | null,
    activeRepoId: RepoId | null,
) => {
    mocks.useEngagementWorkspace.mockReturnValue({ data: workspace });
    useUiStore.setState({ activeEngagementId, activeRepoId });
};

describe('DocumentTitle', () => {
    afterEach(() => {
        cleanup();
        mocks.setDesktopWindowTitle.mockClear();
        useUiStore.setState({ activeEngagementId: null, activeRepoId: null });
    });

    test('uses the active workspace and repository context for browser and desktop titles', () => {
        const fullWorkspace = new EngagementWorkspace({
            engagements: [client],
            activeEngagementId: engagementId,
            unassignedRepositories: [tools],
        });
        setContext(fullWorkspace, engagementId, repoId);
        const { rerender } = render(<DocumentTitle />);

        expect(document.title).toBe('Client A · api • cBranch');
        expect(mocks.setDesktopWindowTitle).toHaveBeenLastCalledWith(
            'Client A · api • cBranch',
        );

        setContext(fullWorkspace, engagementId, null);
        rerender(<DocumentTitle />);
        expect(document.title).toBe('Client A • cBranch');

        setContext(fullWorkspace, null, repoId);
        rerender(<DocumentTitle />);
        expect(document.title).toBe('api • cBranch');

        setContext(undefined, null, null);
        rerender(<DocumentTitle />);
        expect(document.title).toBe('cBranch');
    });
});
