import { type Oid, type RepoId } from '@cbranch/rpc-contract';
import { useMemo } from 'react';

import { buildLogQuery, hasActiveFilters } from '../lib/filters';
import { useUiStore } from '../state/store';
import { HistoryList } from './HistoryList';

export function HistoryPane({
    repoId,
    selectedOid,
    onSelectOid,
}: {
    readonly repoId: RepoId;
    readonly selectedOid: Oid | null;
    readonly onSelectOid: (oid: Oid) => void;
}) {
    const filters = useUiStore(s => s.filters);
    const dateMode = useUiStore(s => s.dateMode);

    const query = useMemo(
        () => buildLogQuery(repoId, filters),
        [repoId, filters],
    );
    const filtersActive = hasActiveFilters(filters);

    return (
        <div className="flex h-full min-h-0 flex-col">
            <HistoryList
                query={query}
                dateMode={dateMode}
                filtersActive={filtersActive}
                selectedOid={selectedOid}
                onSelectOid={onSelectOid}
            />
        </div>
    );
}
