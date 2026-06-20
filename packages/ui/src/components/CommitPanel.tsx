import { type RepoId } from "@cbranch/rpc-contract";
import { useState } from "react";
import { toast } from "sonner";

import { hasStagedChanges } from "../lib/status";
import { useCommitCreate, useLastMessage, useStatus } from "../rpc/hooks";
import { useUiStore } from "../state/store";
import { CommitMessageEditor } from "./CommitMessageEditor";
import { ConventionalCommitBar } from "./ConventionalCommitBar";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";

interface CommitPanelProps {
  repoId: RepoId;
}

export function CommitPanel({ repoId }: CommitPanelProps) {
  const commitDraft = useUiStore((s) => s.commitDraft);
  const updateCommitDraft = useUiStore((s) => s.updateCommitDraft);
  const resetCommitDraft = useUiStore((s) => s.resetCommitDraft);

  const statusQuery = useStatus(repoId);
  const lastMessageQuery = useLastMessage(repoId);
  const commitCreate = useCommitCreate(repoId);

  const [ccType, setCcType] = useState("");
  const [ccScope, setCcScope] = useState("");
  const [ccBreaking, setCcBreaking] = useState(false);

  const hasStaged = statusQuery.data
    ? hasStagedChanges(statusQuery.data)
    : false;
  const subjectEmpty = commitDraft.subject.trim() === "";

  let disabledReason: string | null = null;
  if (!hasStaged && !commitDraft.amend) disabledReason = "No staged changes";
  else if (subjectEmpty) disabledReason = "Enter a commit message";

  const handleCcChange = (type: string, scope: string, breaking: boolean) => {
    setCcType(type);
    setCcScope(scope);
    setCcBreaking(breaking);
    if (type) {
      const prefix =
        type + (scope ? `(${scope})` : "") + (breaking ? "!" : "") + ": ";
      const existing = commitDraft.subject.replace(
        /^[a-z]+(\([^)]*\))?!?: /,
        "",
      );
      updateCommitDraft({ subject: prefix + existing });
    }
  };

  const handleCommit = () => {
    commitCreate.mutate(
      {
        repoId,
        subject: commitDraft.subject.trim(),
        body: commitDraft.body.trim() || undefined,
        amend: commitDraft.amend,
        signoff: commitDraft.signoff,
        allowEmpty: false,
        noVerify: false,
      },
      {
        onSuccess: () => {
          toast.success("Committed");
          resetCommitDraft();
          setCcType("");
          setCcScope("");
          setCcBreaking(false);
        },
      },
    );
  };

  const handleReuseLastMessage = () => {
    const msg = lastMessageQuery.data;
    if (msg) {
      updateCommitDraft({ subject: msg.subject, body: msg.body ?? "" });
    }
  };

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-0 border-t text-xs">
        <ConventionalCommitBar
          type={ccType}
          scope={ccScope}
          breaking={ccBreaking}
          onChange={handleCcChange}
        />
        <CommitMessageEditor
          subject={commitDraft.subject}
          body={commitDraft.body}
          onSubjectChange={(s) => updateCommitDraft({ subject: s })}
          onBodyChange={(b) => updateCommitDraft({ body: b })}
        />
        <div className="flex items-center gap-3 border-t px-2 py-1">
          <div className="flex items-center gap-1.5 text-xs">
            <Switch
              size="sm"
              checked={commitDraft.amend}
              onCheckedChange={(v) => updateCommitDraft({ amend: v })}
              aria-label="Amend"
            />
            <span>Amend</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            <Switch
              size="sm"
              checked={commitDraft.signoff}
              onCheckedChange={(v) => updateCommitDraft({ signoff: v })}
              aria-label="Sign-off"
            />
            <span>Sign-off</span>
          </div>
        </div>
        <div className="flex items-center justify-end gap-1.5 border-t px-2 py-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleReuseLastMessage}
            disabled={!lastMessageQuery.data}
            className="h-6 text-xs"
          >
            Reuse Last Message
          </Button>
          <Tooltip>
            <TooltipTrigger
              render={<span tabIndex={disabledReason ? 0 : undefined} />}
            >
              <Button
                size="sm"
                onClick={handleCommit}
                disabled={disabledReason !== null || commitCreate.isPending}
                className="h-6 text-xs"
              >
                {commitCreate.isPending ? "Committing…" : "Commit"}
              </Button>
            </TooltipTrigger>
            {disabledReason && (
              <TooltipContent>
                <p>{disabledReason}</p>
              </TooltipContent>
            )}
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  );
}
