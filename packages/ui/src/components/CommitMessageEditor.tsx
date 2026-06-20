interface CommitMessageEditorProps {
  subject: string;
  body: string;
  onSubjectChange: (s: string) => void;
  onBodyChange: (s: string) => void;
}

export function CommitMessageEditor({
  subject,
  body,
  onSubjectChange,
  onBodyChange,
}: CommitMessageEditorProps) {
  const overLimit = subject.length > 72;
  return (
    <div className="flex flex-col gap-1 px-2 py-1">
      <div className="relative">
        <input
          type="text"
          value={subject}
          onChange={(e) => onSubjectChange(e.target.value)}
          placeholder="Summary (required)"
          aria-label="Commit subject"
          className="border-input focus:ring-ring/50 h-7 w-full rounded-none border bg-transparent px-2 text-xs focus:ring-1 focus:outline-none"
        />
        {overLimit && (
          <span
            className="text-destructive absolute top-1 right-2 text-[10px]"
            aria-live="polite"
          >
            {subject.length}/72
          </span>
        )}
      </div>
      <textarea
        value={body}
        onChange={(e) => onBodyChange(e.target.value)}
        placeholder="Extended description (optional)"
        aria-label="Commit body"
        rows={3}
        className="border-input focus:ring-ring/50 w-full resize-none rounded-none border bg-transparent px-2 py-1 text-xs focus:ring-1 focus:outline-none"
      />
    </div>
  );
}
