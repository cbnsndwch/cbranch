import { type Ref } from "react";

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
    <div className="flex flex-col gap-1 px-2 py-1">
      <div className="relative">
        <input
          ref={subjectRef}
          type="text"
          value={subject}
          onChange={(e) => onSubjectChange(e.target.value)}
          placeholder="Summary (required)"
          aria-label="Commit subject"
          className="border-input focus:ring-ring/50 h-7 w-full rounded-none border bg-transparent px-2 text-xs focus:ring-1 focus:outline-none"
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
      <textarea
        value={body}
        onChange={(e) => onBodyChange(e.target.value)}
        placeholder="Extended description (optional)"
        aria-label="Commit body"
        rows={bodyRows}
        className="border-input focus:ring-ring/50 w-full resize-none rounded-none border bg-transparent px-2 py-1 text-xs focus:ring-1 focus:outline-none"
      />
    </div>
  );
}
