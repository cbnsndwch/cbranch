import { X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import { cn } from "../lib/cn";
import { clearFilter, describeFilters, type LogFilters, type RefScope } from "../lib/filters";
import { type DateMode } from "../lib/format";

// History filter bar (P1-UI-FILT-1/3): ref-scope segmented control, path/author/message/
// date inputs, removable active-filter chips, and the relative/absolute date toggle. Text
// fields are applied on submit (Enter) so a keystroke does not spawn a git traversal;
// ref-scope, chip removal, and the date toggle apply immediately. Applying re-issues the
// history load from the top of the new result set (P1-FILT-8, handled by the stream hook).

const SCOPES: ReadonlyArray<readonly [RefScope, string]> = [
  ["current", "Current"],
  ["all", "All"],
  ["pattern", "Custom"],
];

const Field = ({
  label,
  value,
  placeholder,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly onChange: (value: string) => void;
}) => (
  <label className="text-muted-foreground flex items-center gap-1 text-[11px]">
    {label}
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className="bg-input/40 text-foreground focus:border-ring w-28 border px-1 py-0.5 text-xs outline-none"
    />
  </label>
);

export function FilterBar({
  filters,
  onChange,
  dateMode,
  onDateModeChange,
}: {
  readonly filters: LogFilters;
  readonly onChange: (filters: LogFilters) => void;
  readonly dateMode: DateMode;
  readonly onDateModeChange: (mode: DateMode) => void;
}) {
  // Draft mirrors the applied filters; text edits commit on submit, discrete controls apply now.
  const [draft, setDraft] = useState<LogFilters>(filters);
  useEffect(() => setDraft(filters), [filters]);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    onChange(draft);
  };
  const setScope = (refScope: RefScope) => {
    const next = { ...draft, refScope };
    setDraft(next);
    onChange(next);
  };
  const chips = describeFilters(filters);

  return (
    <div className="flex flex-col gap-1 border-b px-2 py-1.5">
      <form onSubmit={apply} className="flex flex-wrap items-center gap-2">
        <div className="flex items-center" role="group" aria-label="Ref scope">
          {SCOPES.map(([scope, label]) => (
            <button
              key={scope}
              type="button"
              onClick={() => setScope(scope)}
              aria-pressed={draft.refScope === scope}
              className={cn(
                "border px-1.5 py-0.5 text-[11px] first:rounded-l last:rounded-r",
                draft.refScope === scope ? "bg-accent text-accent-foreground" : "text-muted-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {draft.refScope === "pattern" ? (
          <Field
            label="pattern"
            value={draft.refPattern}
            placeholder="refs/heads/*"
            onChange={(refPattern) => setDraft({ ...draft, refPattern })}
          />
        ) : null}
        <Field label="path" value={draft.path} onChange={(path) => setDraft({ ...draft, path })} />
        <Field label="author" value={draft.author} onChange={(author) => setDraft({ ...draft, author })} />
        <Field label="msg" value={draft.grep} onChange={(grep) => setDraft({ ...draft, grep })} />
        <Field
          label="since"
          value={draft.since}
          placeholder="2024-01-01"
          onChange={(since) => setDraft({ ...draft, since })}
        />
        <Field
          label="until"
          value={draft.until}
          placeholder="2024-12-31"
          onChange={(until) => setDraft({ ...draft, until })}
        />
        <button type="submit" className="hover:bg-accent border px-1.5 py-0.5 text-[11px]">
          Apply
        </button>
        <div className="ml-auto flex items-center" role="group" aria-label="Date format">
          {(["relative", "absolute"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => onDateModeChange(mode)}
              aria-pressed={dateMode === mode}
              className={cn(
                "border px-1.5 py-0.5 text-[11px] capitalize first:rounded-l last:rounded-r",
                dateMode === mode ? "bg-accent text-accent-foreground" : "text-muted-foreground",
              )}
            >
              {mode}
            </button>
          ))}
        </div>
      </form>
      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() => onChange(clearFilter(filters, chip.key))}
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 border px-1 text-[10px]"
              aria-label={`Clear ${chip.label}`}
            >
              {chip.label}
              <X className="size-3" aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
