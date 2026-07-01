// Mirror the URL's route params into the Zustand store (D13). The URL is the source of truth
// for `activeRepoId` / `selectedOid`; this bridge keeps the legacy store subscribers
// (DocumentTitle, Toolbar, AppShell, …) working without rewiring each one to read params directly.
//
// `useLayoutEffect` runs before paint so the store is consistent with the URL on the first
// frame of a deep-link load — no flash of the empty/previous state.

import { type Oid, type RepoId } from '@cbranch/rpc-contract';
import { useLayoutEffect } from 'react';
import { useParams } from 'react-router';

import { useUiStore } from './store';

export function SyncRouteToStore() {
    const { repoId, oid } = useParams<{ repoId?: string; oid?: string }>();
    const activeRepoId = useUiStore(s => s.activeRepoId);

    // Repo changes reset selection + filters (P1-OPEN-4), so only fire when it actually changes.
    useLayoutEffect(() => {
        const next: RepoId | null = repoId ? (repoId as RepoId) : null;
        if (next !== activeRepoId) useUiStore.getState().setActiveRepoId(next);
    }, [repoId, activeRepoId]);

    useLayoutEffect(() => {
        useUiStore.getState().setSelectedOid(oid ? (oid as Oid) : null);
    }, [oid]);

    return null;
}
