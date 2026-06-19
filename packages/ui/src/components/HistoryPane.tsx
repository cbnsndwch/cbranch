import { type Oid, type RepoId } from "@cbranch/rpc-contract";
import { useMemo } from "react";

import { buildLogQuery, hasActiveFilters } from "../lib/filters";
import { useUiStore } from "../state/store";
import { FilterBar } from "./FilterBar";
import { HistoryList } from "./HistoryList";

// The left history pane: the filter bar over the virtualized graph/history list. Owns the
// store reads and derives a stable `LogQuery` from the active filters (P1-FILT-*), so the
// stream restarts only when a filter actually changes.
export function HistoryPane({
  repoId,
  selectedOid,
  onSelectOid,
}: {
  readonly repoId: RepoId;
  readonly selectedOid: Oid | null;
  readonly onSelectOid: (oid: Oid) => void;
}) {
  const filters = useUiStore((s) => s.filters);
  const setFilters = useUiStore((s) => s.setFilters);
  const dateMode = useUiStore((s) => s.dateMode);
  const setDateMode = useUiStore((s) => s.setDateMode);

  const query = useMemo(() => buildLogQuery(repoId, filters), [repoId, filters]);
  const filtersActive = hasActiveFilters(filters);

  return (
    <div className="flex h-full flex-col">
      <FilterBar filters={filters} onChange={setFilters} dateMode={dateMode} onDateModeChange={setDateMode} />
      <div className="min-h-0 flex-1">
        <HistoryList
          query={query}
          dateMode={dateMode}
          filtersActive={filtersActive}
          selectedOid={selectedOid}
          onSelectOid={onSelectOid}
        />
      </div>
    </div>
  );
}
