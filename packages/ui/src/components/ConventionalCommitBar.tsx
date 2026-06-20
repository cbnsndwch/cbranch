import { Switch } from "./ui/switch";

const COMMIT_TYPES = ["feat", "fix", "docs", "style", "refactor", "test", "chore", "ci", "perf", "build", "revert"];

interface ConventionalCommitBarProps {
  type: string;
  scope: string;
  breaking: boolean;
  onChange: (type: string, scope: string, breaking: boolean) => void;
}

export function ConventionalCommitBar({ type, scope, breaking, onChange }: ConventionalCommitBarProps) {
  return (
    <div className="flex items-center gap-1.5 border-b px-2 py-1 text-xs">
      <select
        value={type}
        onChange={(e) => onChange(e.target.value, scope, breaking)}
        className="border-input h-6 rounded-none border bg-transparent px-1 text-xs focus:outline-none"
        aria-label="Commit type"
      >
        <option value="">type</option>
        {COMMIT_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <span className="text-muted-foreground">(</span>
      <input
        type="text"
        value={scope}
        onChange={(e) => onChange(type, e.target.value, breaking)}
        placeholder="scope"
        className="border-input h-6 w-20 rounded-none border bg-transparent px-1 text-xs focus:outline-none"
        aria-label="Commit scope"
      />
      <span className="text-muted-foreground">)</span>
      <label className="text-muted-foreground flex items-center gap-1 text-xs">
        <Switch
          size="sm"
          checked={breaking}
          onCheckedChange={(v) => onChange(type, scope, v)}
          aria-label="Breaking change"
        />
        breaking
      </label>
    </div>
  );
}
