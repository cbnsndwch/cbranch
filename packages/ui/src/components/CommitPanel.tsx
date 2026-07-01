import { type CommitInput, type RepoId } from '@cbranch/rpc-contract';
import { ChevronDown, X } from 'lucide-react';
import {
    forwardRef,
    useEffect,
    useImperativeHandle,
    useRef,
    useState,
} from 'react';
import { toast } from 'sonner';

import { hasStagedChanges } from '../lib/status';
import {
    useCommitCreate,
    useLastMessage,
    useRepoState,
    useStatus,
} from '../rpc/hooks';
import { useUiStore } from '../state/store';
import { CommitMessageEditor } from './CommitMessageEditor';
import { ConventionalCommitBar } from './ConventionalCommitBar';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Switch } from './ui/switch';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from './ui/tooltip';

interface CommitPanelProps {
    repoId: RepoId;
    /** Called after a successful commit when "keep open" is OFF, so the host can close. */
    onCommitted?: () => void;
    /** Renders a Cancel action wired to this callback (the dialog's lenient dismissal). */
    onCancel?: () => void;
    /** Focus the subject field on mount (the dialog opens straight into composing). */
    autoFocusSubject?: boolean;
}

/** Imperative handle so the dialog can fire Commit on Ctrl/Cmd+Enter from anywhere (§6). */
export interface CommitPanelHandle {
    commit: () => void;
}

export const CommitPanel = forwardRef<CommitPanelHandle, CommitPanelProps>(
    function CommitPanel(
        { repoId, onCommitted, onCancel, autoFocusSubject = false },
        ref,
    ) {
        const commitDraft = useUiStore(s => s.commitDraft);
        const updateCommitDraft = useUiStore(s => s.updateCommitDraft);
        const resetCommitDraft = useUiStore(s => s.resetCommitDraft);
        const keepOpen = useUiStore(s => s.keepOpenAfterCommit);
        const setKeepOpen = useUiStore(s => s.setKeepOpenAfterCommit);

        const statusQuery = useStatus(repoId);
        const repoStateQuery = useRepoState(repoId);
        const lastMessageQuery = useLastMessage(repoId);
        const commitCreate = useCommitCreate(repoId);

        const subjectRef = useRef<HTMLInputElement>(null);
        useEffect(() => {
            if (autoFocusSubject) subjectRef.current?.focus();
        }, [autoFocusSubject]);
        const [ccType, setCcType] = useState('');
        const [ccScope, setCcScope] = useState('');
        const [ccBreaking, setCcBreaking] = useState(false);
        // A persistent, dismissible commit error (not a transient toast): commit errors are
        // worth reading and copying — a toast disappears before you can. Cleared on the next
        // attempt and on success.
        const [commitError, setCommitError] = useState<string | null>(null);

        const status = statusQuery.data;
        const repoState = repoStateQuery.data;

        // Edge states (docs/design/commit-surface.md §7).
        const isUnborn = repoState ? repoState.headOid === undefined : false;
        const isDetached = repoState?.isDetached ?? false;
        const hasConflicts = status?.hasConflicts ?? false;
        const hasStaged = status ? hasStagedChanges(status) : false;
        const subjectEmpty = commitDraft.subject.trim() === '';
        const authorIncomplete =
            commitDraft.authorOverride &&
            (commitDraft.authorName.trim() === '' ||
                commitDraft.authorEmail.trim() === '');

        // Amend is invalid on an unborn HEAD; force the toggle off if it somehow got set.
        const amendActive = commitDraft.amend && !isUnborn;

        // Best-effort "amend of a pushed HEAD" warning from tracking info (§7): the branch
        // has an upstream and the local tip is not ahead, so the commit being rewritten is
        // very likely already published.
        const amendOfPushed =
            amendActive &&
            status?.branch?.upstream !== undefined &&
            (status.branch.ahead ?? 0) === 0;

        let disabledReason: string | null = null;
        if (hasConflicts)
            disabledReason = 'Resolve conflicts before committing';
        else if (authorIncomplete)
            disabledReason = 'Enter author name and email';
        else if (!hasStaged && !amendActive && !commitDraft.allowEmpty)
            disabledReason = 'No staged changes';
        else if (subjectEmpty) disabledReason = 'Enter a commit message';

        const handleCcChange = (
            type: string,
            scope: string,
            breaking: boolean,
        ) => {
            setCcType(type);
            setCcScope(scope);
            setCcBreaking(breaking);
            if (type) {
                const prefix =
                    type +
                    (scope ? `(${scope})` : '') +
                    (breaking ? '!' : '') +
                    ': ';
                const existing = commitDraft.subject.replace(
                    /^[a-z]+(\([^)]*\))?!?: /,
                    '',
                );
                updateCommitDraft({ subject: prefix + existing });
            }
        };

        const handleAmendToggle = (next: boolean) => {
            updateCommitDraft({
                amend: next,
                resetAuthor: next && commitDraft.resetAuthor,
            });
            // Pre-fill the previous message when turning amend on over an empty draft (§4).
            if (next && subjectEmpty && commitDraft.body.trim() === '') {
                const msg = lastMessageQuery.data;
                if (msg)
                    updateCommitDraft({ subject: msg.subject, body: msg.body });
            }
        };

        const handleCommit = () => {
            if (disabledReason !== null || commitCreate.isPending) return;
            setCommitError(null);
            const input: CommitInput = {
                repoId,
                subject: commitDraft.subject.trim(),
                body: commitDraft.body.trim() || undefined,
                amend: amendActive,
                resetAuthor:
                    amendActive && commitDraft.resetAuthor ? true : undefined,
                signoff: commitDraft.signoff,
                sign: commitDraft.sign
                    ? { format: commitDraft.signFormat }
                    : undefined,
                authorOverride: commitDraft.authorOverride
                    ? {
                          name: commitDraft.authorName.trim(),
                          email: commitDraft.authorEmail.trim(),
                      }
                    : undefined,
                allowEmpty: commitDraft.allowEmpty,
                noVerify: false,
            };

            commitCreate.mutate(input, {
                onSuccess: created => {
                    toast.success(
                        `Committed ${created.shortOid} — ${created.subject}`,
                    );
                    setCommitError(null);
                    resetCommitDraft();
                    setCcType('');
                    setCcScope('');
                    setCcBreaking(false);
                    if (keepOpen) {
                        // Stay open for the next commit; return focus to the subject field (§5).
                        subjectRef.current?.focus();
                    } else {
                        onCommitted?.();
                    }
                },
                onError: err => {
                    // Persist the error in the dialog (see `commitError`) rather than a toast
                    // that vanishes before it can be read.
                    setCommitError(String(err));
                },
            });
        };

        useImperativeHandle(ref, () => ({ commit: handleCommit }));

        const handleReuseLastMessage = () => {
            const msg = lastMessageQuery.data;
            if (msg)
                updateCommitDraft({ subject: msg.subject, body: msg.body });
        };

        const reuseDisabled = isUnborn || !lastMessageQuery.data;

        return (
            <TooltipProvider>
                <div className="flex flex-col gap-0 text-xs">
                    <ConventionalCommitBar
                        type={ccType}
                        scope={ccScope}
                        breaking={ccBreaking}
                        onChange={handleCcChange}
                    />
                    <CommitMessageEditor
                        subject={commitDraft.subject}
                        body={commitDraft.body}
                        onSubjectChange={s => updateCommitDraft({ subject: s })}
                        onBodyChange={b => updateCommitDraft({ body: b })}
                        subjectRef={subjectRef}
                        bodyRows={4}
                    />

                    {/* Contextual notices (§7). */}
                    {(isUnborn || isDetached || amendOfPushed) && (
                        <div className="flex flex-col gap-0.5 px-2 pb-1">
                            {isUnborn && (
                                <p className="text-muted-foreground text-[11px]">
                                    Unborn branch — this will create the first
                                    commit. Amend, reset author and
                                    reuse-message are unavailable.
                                </p>
                            )}
                            {isDetached && (
                                <p className="text-muted-foreground text-[11px]">
                                    Detached HEAD — committing here won&apos;t
                                    advance any branch.
                                </p>
                            )}
                            {amendOfPushed && (
                                <p className="text-amber-600 text-[11px] dark:text-amber-400">
                                    ⚠ Amending a commit that appears already
                                    pushed — you&apos;ll need a force-push
                                    afterwards.
                                </p>
                            )}
                        </div>
                    )}

                    {/* Options (§4). */}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1">
                        <span className="flex items-center gap-1.5">
                            <Switch
                                size="sm"
                                checked={amendActive}
                                disabled={isUnborn}
                                onCheckedChange={handleAmendToggle}
                                aria-label="Amend"
                            />
                            <span>Amend</span>
                        </span>
                        {amendActive && (
                            <span className="flex items-center gap-1.5">
                                <Switch
                                    size="sm"
                                    checked={commitDraft.resetAuthor}
                                    onCheckedChange={v =>
                                        updateCommitDraft({ resetAuthor: v })
                                    }
                                    aria-label="Reset author"
                                />
                                <span>Reset author</span>
                            </span>
                        )}
                        <span className="flex items-center gap-1.5">
                            <Switch
                                size="sm"
                                checked={commitDraft.signoff}
                                onCheckedChange={v =>
                                    updateCommitDraft({ signoff: v })
                                }
                                aria-label="Sign-off"
                            />
                            <span>Sign-off</span>
                        </span>
                        <span className="flex items-center gap-1.5">
                            <Switch
                                size="sm"
                                checked={commitDraft.sign}
                                onCheckedChange={v =>
                                    updateCommitDraft({ sign: v })
                                }
                                aria-label="Sign"
                            />
                            <span>Sign</span>
                        </span>
                        {commitDraft.sign && (
                            <select
                                value={commitDraft.signFormat}
                                onChange={e =>
                                    updateCommitDraft({
                                        signFormat: e.target.value as
                                            | 'gpg'
                                            | 'ssh',
                                    })
                                }
                                aria-label="Signing format"
                                className="border-input h-5.5 rounded-none border bg-transparent text-[11px]"
                            >
                                <option value="gpg">GPG</option>
                                <option value="ssh">SSH</option>
                            </select>
                        )}
                        <span className="flex items-center gap-1.5">
                            <Switch
                                size="sm"
                                checked={commitDraft.allowEmpty}
                                onCheckedChange={v =>
                                    updateCommitDraft({ allowEmpty: v })
                                }
                                aria-label="Allow empty"
                            />
                            <span>Allow empty</span>
                        </span>
                        <button
                            type="button"
                            onClick={() =>
                                updateCommitDraft({
                                    authorOverride: !commitDraft.authorOverride,
                                })
                            }
                            aria-expanded={commitDraft.authorOverride}
                            className="text-muted-foreground hover:text-foreground flex items-center gap-0.5"
                        >
                            <ChevronDown
                                className={
                                    commitDraft.authorOverride
                                        ? 'size-3 rotate-180 transition-transform'
                                        : 'size-3 transition-transform'
                                }
                                aria-hidden="true"
                            />
                            Author override
                        </button>
                    </div>

                    {commitDraft.authorOverride && (
                        <div className="flex items-center gap-2 border-t px-2 py-1">
                            <input
                                type="text"
                                value={commitDraft.authorName}
                                onChange={e =>
                                    updateCommitDraft({
                                        authorName: e.target.value,
                                    })
                                }
                                placeholder="Author name"
                                aria-label="Author name"
                                className="border-input h-6 flex-1 rounded-none border bg-transparent px-1.5 text-[11px]"
                            />
                            <input
                                type="email"
                                value={commitDraft.authorEmail}
                                onChange={e =>
                                    updateCommitDraft({
                                        authorEmail: e.target.value,
                                    })
                                }
                                placeholder="author@example.com"
                                aria-label="Author email"
                                className="border-input h-6 flex-1 rounded-none border bg-transparent px-1.5 text-[11px]"
                            />
                        </div>
                    )}

                    {/* Persistent commit error (§7) — stays until dismissed or the next attempt. */}
                    {commitError && (
                        <div className="border-destructive/40 bg-destructive/10 text-destructive flex items-start gap-2 border-t px-2 py-1.5 text-[11px]">
                            <span className="min-w-0 flex-1 wrap-break-word whitespace-pre-wrap select-text">
                                {commitError}
                            </span>
                            <button
                                type="button"
                                onClick={() => setCommitError(null)}
                                aria-label="Dismiss error"
                                className="hover:text-foreground shrink-0"
                            >
                                <X className="size-3.5" aria-hidden="true" />
                            </button>
                        </div>
                    )}

                    {/* Actions (§4/§5). */}
                    <div className="flex items-center justify-between gap-2 border-t px-2 py-1.5">
                        <span className="flex items-center gap-1.5">
                            <Checkbox
                                checked={keepOpen}
                                onCheckedChange={v => setKeepOpen(v === true)}
                                aria-label="Keep open after commit"
                            />
                            <span>Keep open after commit</span>
                        </span>
                        <div className="flex items-center gap-1.5">
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={handleReuseLastMessage}
                                disabled={reuseDisabled}
                                className="h-7 text-xs"
                            >
                                Reuse Last Message
                            </Button>
                            {onCancel && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={onCancel}
                                    disabled={commitCreate.isPending}
                                    className="h-7 text-xs"
                                >
                                    Cancel
                                </Button>
                            )}
                            {/* Split Commit button — caret reserves "Commit & push" (P3, §8). */}
                            <div className="flex">
                                <Tooltip>
                                    <TooltipTrigger
                                        render={
                                            <span
                                                tabIndex={
                                                    disabledReason
                                                        ? 0
                                                        : undefined
                                                }
                                            />
                                        }
                                    >
                                        <Button
                                            size="sm"
                                            onClick={handleCommit}
                                            disabled={
                                                disabledReason !== null ||
                                                commitCreate.isPending
                                            }
                                            className="h-7 text-xs"
                                        >
                                            {commitCreate.isPending
                                                ? 'Committing…'
                                                : 'Commit'}
                                        </Button>
                                    </TooltipTrigger>
                                    {disabledReason && (
                                        <TooltipContent>
                                            <p>{disabledReason}</p>
                                        </TooltipContent>
                                    )}
                                </Tooltip>
                                <DropdownMenu>
                                    <DropdownMenuTrigger
                                        render={
                                            <Button
                                                size="sm"
                                                aria-label="More commit actions"
                                                className="h-7 w-6 border-l border-primary-foreground/20 px-0"
                                            >
                                                <ChevronDown
                                                    className="size-3"
                                                    aria-hidden="true"
                                                />
                                            </Button>
                                        }
                                    />
                                    <DropdownMenuContent align="end">
                                        <DropdownMenuItem disabled>
                                            Commit &amp; push (coming soon)
                                        </DropdownMenuItem>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </div>
                        </div>
                    </div>
                </div>
            </TooltipProvider>
        );
    },
);
