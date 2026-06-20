import { type Oid, type RepoId } from "@cbranch/rpc-contract";

import { formatEpoch, formatInstant, shortOid } from "../lib/format";
import { useCommitDetail } from "../rpc/hooks";
import { useUiStore } from "../state/store";
import { Placeholder } from "./ui/placeholder";

const initials = (name: string): string => {
  const parts = name.trim().split(/\s+/);
  return (
    parts
      .map((p) => p[0] ?? "")
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
};

export function CommitTab({
  repoId,
  oid,
  onSelectOid,
}: {
  readonly repoId: RepoId | null;
  readonly oid: Oid | null;
  readonly onSelectOid: (oid: Oid) => void;
}) {
  const { data, isLoading, isError } = useCommitDetail(repoId, oid);
  const dateMode = useUiStore((s) => s.dateMode);
  const knownRefStrings = useUiStore((s) => s.knownRefStrings);

  if (oid === null) return <Placeholder>Select a commit to see its details.</Placeholder>;
  if (isLoading) return <Placeholder>Loading commit…</Placeholder>;
  if (isError || !data) return <Placeholder tone="danger">Could not load commit {shortOid(oid)}.</Placeholder>;

  const authorInitials = initials(data.author.name);

  // Derive branches from known ref strings
  const containedBranches = knownRefStrings
    .filter((r) => {
      if (r === "HEAD") return false;
      if (r.startsWith("tag: ")) return false;
      if (r.startsWith("HEAD -> ")) return true;
      // local branch (no slash)
      if (!r.includes("/")) return true;
      return false;
    })
    .map((r) => (r.startsWith("HEAD -> ") ? r.slice("HEAD -> ".length) : r));

  return (
    <div className="flex h-full gap-3 overflow-auto p-3 text-[11px]">
      {/* Avatar */}
      <div
        className="flex size-[78px] shrink-0 items-center justify-center text-[22px] font-semibold text-white"
        style={{ background: "var(--color-status-staged)" }}
        aria-hidden="true"
      >
        {authorInitials}
      </div>
      {/* Metadata column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <dt className="text-muted-foreground">Author:</dt>
          <dd>
            {data.author.name} &lt;{data.author.email}&gt;
          </dd>
          <dt className="text-muted-foreground">Date:</dt>
          <dd>
            {formatInstant(data.author.when.epochSeconds, dateMode)}{" "}
            <span className="text-muted-foreground">({formatEpoch(data.author.when.epochSeconds)})</span>
          </dd>
          <dt className="text-muted-foreground">Commit hash:</dt>
          <dd className="font-mono break-all">{data.oid}</dd>
          {data.parents.length > 0 ? (
            <>
              <dt className="text-muted-foreground">Parent:</dt>
              <dd>
                {data.parents.map((parent) => (
                  <button
                    key={parent}
                    type="button"
                    onClick={() => onSelectOid(parent)}
                    className="text-primary mr-2 font-mono hover:underline"
                  >
                    {shortOid(parent)}
                  </button>
                ))}
              </dd>
            </>
          ) : null}
        </dl>
        {/* Subject strip */}
        <div className="bg-muted mt-2 px-2 py-1.5 text-[12px]">{data.subject}</div>
        {/* Contained in branches */}
        <div className="mt-2">
          <div className="text-muted-foreground">Contained in branches:</div>
          {containedBranches.length > 0 ? (
            containedBranches.map((name) => (
              <div key={name} className="text-primary">
                {name}
              </div>
            ))
          ) : (
            <div className="text-muted-foreground">—</div>
          )}
        </div>
      </div>
    </div>
  );
}
