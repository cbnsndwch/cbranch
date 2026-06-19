import { type Oid, type RepoId } from "@cbranch/rpc-contract";

import { formatEpoch, shortOid } from "../lib/format";
import { useCommitDetail } from "../rpc/hooks";
import { Placeholder } from "./ui/placeholder";

// Commit details (P1-DET-1/3 + P1-UI-DET-1): identity, author/committer, full message,
// and navigable parents. Pointing-refs and the merge parent selector arrive in polish.
export function DetailsPanel({
  repoId,
  oid,
  onSelectOid,
}: {
  readonly repoId: RepoId;
  readonly oid: Oid | null;
  readonly onSelectOid: (oid: Oid) => void;
}) {
  const { data, isLoading, isError } = useCommitDetail(repoId, oid);

  if (oid === null) return <Placeholder>Select a commit to see its details.</Placeholder>;
  if (isLoading) return <Placeholder>Loading commit…</Placeholder>;
  if (isError || !data) return <Placeholder tone="danger">Could not load commit {shortOid(oid)}.</Placeholder>;

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-3 text-sm">
      <div>
        <div className="text-muted-foreground font-mono text-xs break-all">{data.oid}</div>
        <div className="mt-1 font-medium">{data.subject}</div>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">author</dt>
        <dd>
          {data.author.name} &lt;{data.author.email}&gt; · {formatEpoch(data.author.when.epochSeconds)}
        </dd>
        <dt className="text-muted-foreground">committer</dt>
        <dd>
          {data.committer.name} · {formatEpoch(data.committer.when.epochSeconds)}
        </dd>
      </dl>
      {data.body ? <pre className="text-xs whitespace-pre-wrap">{data.body}</pre> : null}
      {data.parents.length > 0 ? (
        <div className="text-xs">
          <span className="text-muted-foreground">parents: </span>
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
        </div>
      ) : null}
    </div>
  );
}
