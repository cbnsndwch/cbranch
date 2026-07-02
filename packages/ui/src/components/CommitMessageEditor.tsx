import { type Ref } from 'react';

import { Input } from './ui/input';
import { Textarea } from './ui/textarea';

interface CommitMessageEditorProps {
    subject: string;
    body: string;
    onSubjectChange: (s: string) => void;
    onBodyChange: (s: string) => void;
    /** Optional ref to the subject input, so the dialog can return focus after a commit. */
    subjectRef?: Ref<HTMLInputElement>;
    /** Rows for the body textarea (the dialog gives it more room than the legacy panel). */
    bodyRows?: number;
}

// Soft ~50-char subject guide (docs/design/commit-surface.md §4) — non-blocking, never
// mutates the text; the count simply appears once the conventional 50-char summary
// length is exceeded.
const SUBJECT_SOFT_LIMIT = 50;

export function CommitMessageEditor({
    subject,
    body,
    onSubjectChange,
    onBodyChange,
    subjectRef,
    bodyRows = 3,
}: CommitMessageEditorProps) {
    const overLimit = subject.length > SUBJECT_SOFT_LIMIT;
    return (
        <div className="flex flex-col gap-1 px-2 pb-1">
            <div className="relative">
                <Input
                    ref={subjectRef}
                    value={subject}
                    onChange={e => onSubjectChange(e.target.value)}
                    placeholder="Summary (required)"
                    aria-label="Commit subject"
                    className="h-7 text-xs"
                />
                {overLimit && (
                    <span
                        className="text-muted-foreground absolute top-1 right-2 text-[10px]"
                        aria-live="polite"
                    >
                        {subject.length}/{SUBJECT_SOFT_LIMIT}
                    </span>
                )}
            </div>
            <Textarea
                value={body}
                onChange={e => onBodyChange(e.target.value)}
                placeholder="Extended description (optional)"
                aria-label="Commit body"
                rows={bodyRows}
                className="min-h-0 resize-none text-xs"
            />
        </div>
    );
}
