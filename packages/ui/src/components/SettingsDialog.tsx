// Settings dialog (docs/spec/09-phase5-power.md REQ-P5-CFG-001..008; D18, S7).
//
// Two configs, never crossed (REQ-P5-CFG-005): the "Git config" tab edits git config
// files (per-repo); the "App settings" tab edits cbranch's own theme + keybindings in the
// host config.json. App-global: opens with no repo (the git tab then prompts to open one).

import {
  type GitConfigEntry,
  KeyBinding,
  type RepoId,
} from "@cbranch/rpc-contract";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { setKeybindingCaptureActive } from "../hooks/use-keybindings";
import {
  DEFAULT_KEYBINDINGS,
  eventToChord,
  findConflicts,
  KEYBINDING_COMMANDS,
  keybindingsToRecord,
  mergeBindings,
} from "../lib/keybindings";
import {
  useAppSettings,
  useConfigSet,
  useConfigUnset,
  useGitConfig,
  useSetAppSettings,
} from "../rpc/hooks";
import { useUiStore } from "../state/store";
import type { ThemePref } from "../theme/theme";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";
import { Tabs, TabsList, TabsPanel, TabsTab } from "./ui/tabs";

const FIELD = "h-8 w-full border px-2 text-sm";

type WritableScope = "global" | "local";

// Effective value of a key = the highest-precedence on-disk entry (command > worktree >
// local > global > system); used to prefill the guided editors (REQ-P5-CFG-001). A
// per-worktree config (extensions.worktreeConfig) overrides the repo-local one in git, so
// worktree must outrank local.
const SCOPE_RANK: Readonly<Record<string, number>> = {
  system: 0,
  global: 1,
  local: 2,
  worktree: 3,
  command: 4,
};
const effectiveValue = (
  entries: ReadonlyArray<GitConfigEntry>,
  key: string,
): string => {
  let bestRank = -1;
  let value = "";
  for (const e of entries) {
    if (e.key !== key) continue;
    const rank = SCOPE_RANK[e.scope] ?? 0;
    if (rank >= bestRank) {
      bestRank = rank;
      value = e.value;
    }
  }
  return value;
};

// Keys git stores as multi-valued (multivar). A plain `git config <key> <value>` aborts
// with exit 5 — instead of overwriting — once more than one value already exists, and the
// guided editors only ever write a single value. cbranch can't pass `--replace-all` over
// the current ConfigSet contract, so a failed write of one of these keys surfaces an
// actionable message pointing at the All-config table (REQ-P5-CFG-002/004).
const MULTIVAR_KEYS: ReadonlySet<string> = new Set(["credential.helper"]);

export function SettingsDialog() {
  const open = useUiStore((s) => s.settingsDialogOpen);
  if (!open) return null;
  return <SettingsDialogBody />;
}

function SettingsDialogBody() {
  const setOpen = useUiStore((s) => s.setSettingsDialogOpen);
  const repoId = useUiStore((s) => s.activeRepoId);
  return (
    <Dialog
      open={true}
      onOpenChange={(next: boolean) => {
        if (!next) setOpen(false);
      }}
    >
      <DialogContent style={{ width: "min(760px, 94vw)" }}>
        <div className="flex flex-col gap-3 p-4">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Git config is written to git config files; app settings stay in
            cbranch and never touch your git config.
          </DialogDescription>
          <Tabs defaultValue="git">
            <TabsList>
              <TabsTab value="git">Git config</TabsTab>
              <TabsTab value="app">App settings</TabsTab>
            </TabsList>
            <TabsPanel value="git">
              {repoId === null ? (
                <p className="text-muted-foreground py-6 text-sm">
                  Open a repository to view and edit its git config.
                </p>
              ) : (
                <GitConfigTab repoId={repoId} />
              )}
            </TabsPanel>
            <TabsPanel value="app">
              <AppSettingsTab />
            </TabsPanel>
          </Tabs>
          <div className="flex justify-end pt-1">
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const SCOPE_LABEL: Record<string, string> = {
  global: "Global",
  local: "Local",
  system: "System (read-only)",
};

function GitConfigTab({ repoId }: { repoId: RepoId }) {
  const config = useGitConfig(repoId);
  const set = useConfigSet(repoId);
  const unset = useConfigUnset(repoId);
  const [scope, setScope] = useState<WritableScope>("global");
  const busy = set.isPending || unset.isPending;

  const entries = config.data ?? [];
  const eff = (key: string) => effectiveValue(entries, key);

  const write = (key: string, value: string) => {
    set.mutate(
      { key, value, scope },
      {
        onSuccess: () => toast.success(`Set ${key} (${scope})`),
        onError: () =>
          toast.error(
            MULTIVAR_KEYS.has(key)
              ? `${key} already has multiple values — clear the extras in "All config entries" below, then set it again.`
              : `Could not set ${key}`,
          ),
      },
    );
  };

  return (
    <div className="flex max-h-[60vh] flex-col gap-4 overflow-auto py-2">
      <div className="flex items-center gap-2 text-sm">
        <span id="cfg-scope-label">Write scope</span>
        <Select
          value={scope}
          onValueChange={(v) => setScope((v ?? "global") as WritableScope)}
        >
          <SelectTrigger
            aria-labelledby="cfg-scope-label"
            disabled={busy}
            className="w-44"
          >
            <SelectValue>
              {(value: string) => SCOPE_LABEL[value] ?? value}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="global">Global</SelectItem>
            <SelectItem value="local">Local</SelectItem>
            <SelectItem value="system" disabled>
              System (read-only)
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <IdentitySection eff={eff} busy={busy} onSave={write} />
      <GuidedKey
        label="Default editor"
        configKey="core.editor"
        eff={eff}
        busy={busy}
        onSave={write}
        placeholder="e.g. code --wait"
      />
      <GuidedKey
        label="Credential helper"
        configKey="credential.helper"
        eff={eff}
        busy={busy}
        onSave={write}
        placeholder="e.g. cache, store, manager"
        hint="The helper NAME only — cbranch never stores credentials."
      />
      <DiffMergeSection eff={eff} busy={busy} onSave={write} />

      <AdvancedConfigTable
        entries={entries}
        scope={scope}
        busy={busy}
        onSet={write}
        onUnset={(key, rowScope) =>
          unset.mutate(
            { key, scope: rowScope },
            { onSuccess: () => toast.success(`Unset ${key}`) },
          )
        }
      />
    </div>
  );
}

function IdentitySection({
  eff,
  busy,
  onSave,
}: {
  eff: (key: string) => string;
  busy: boolean;
  onSave: (key: string, value: string) => void;
}) {
  const [name, setName] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const nameVal = name ?? eff("user.name");
  const emailVal = email ?? eff("user.email");
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Identity</h3>
      <input
        className={FIELD}
        aria-label="user.name"
        value={nameVal}
        onChange={(e) => setName(e.target.value)}
        placeholder="Your name"
        disabled={busy}
      />
      <input
        className={FIELD}
        aria-label="user.email"
        value={emailVal}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        disabled={busy}
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            onSave("user.name", nameVal);
            onSave("user.email", emailVal);
          }}
        >
          Save identity
        </Button>
      </div>
    </section>
  );
}

function GuidedKey({
  label,
  configKey,
  eff,
  busy,
  onSave,
  placeholder,
  hint,
}: {
  label: string;
  configKey: string;
  eff: (key: string) => string;
  busy: boolean;
  onSave: (key: string, value: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  const [val, setVal] = useState<string | null>(null);
  const current = val ?? eff(configKey);
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-sm font-medium">{label}</h3>
      <div className="flex gap-2">
        <input
          className={FIELD}
          aria-label={configKey}
          value={current}
          onChange={(e) => setVal(e.target.value)}
          placeholder={placeholder}
          disabled={busy}
        />
        <Button
          size="sm"
          disabled={busy}
          onClick={() => onSave(configKey, current)}
        >
          Save
        </Button>
      </div>
      {hint !== undefined && (
        <p className="text-muted-foreground text-xs">{hint}</p>
      )}
    </section>
  );
}

function DiffMergeSection({
  eff,
  busy,
  onSave,
}: {
  eff: (key: string) => string;
  busy: boolean;
  onSave: (key: string, value: string) => void;
}) {
  const [diffTool, setDiffTool] = useState<string | null>(null);
  const [mergeTool, setMergeTool] = useState<string | null>(null);
  const [diffCmd, setDiffCmd] = useState<string | null>(null);
  const [mergeCmd, setMergeCmd] = useState<string | null>(null);
  const diffToolVal = diffTool ?? eff("diff.tool");
  const mergeToolVal = mergeTool ?? eff("merge.tool");
  // The custom-command fields round-trip the stored difftool/mergetool.<tool>.cmd value
  // for the currently-named tool (REQ-P5-CFG-003), until the user edits them.
  const diffCmdVal = diffCmd ?? eff(`difftool.${diffToolVal}.cmd`);
  const mergeCmdVal = mergeCmd ?? eff(`mergetool.${mergeToolVal}.cmd`);
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Diff &amp; merge tools</h3>
      <div className="grid grid-cols-2 gap-2">
        <input
          className={FIELD}
          aria-label="diff.tool"
          value={diffToolVal}
          onChange={(e) => setDiffTool(e.target.value)}
          placeholder="diff.tool (e.g. vimdiff)"
          disabled={busy}
        />
        <input
          className={FIELD}
          aria-label="merge.tool"
          value={mergeToolVal}
          onChange={(e) => setMergeTool(e.target.value)}
          placeholder="merge.tool (e.g. vimdiff)"
          disabled={busy}
        />
        <input
          className={FIELD}
          aria-label="difftool command"
          value={diffCmdVal}
          onChange={(e) => setDiffCmd(e.target.value)}
          placeholder="custom difftool cmd (optional)"
          disabled={busy}
        />
        <input
          className={FIELD}
          aria-label="mergetool command"
          value={mergeCmdVal}
          onChange={(e) => setMergeCmd(e.target.value)}
          placeholder="custom mergetool cmd (optional)"
          disabled={busy}
        />
      </div>
      <p className="text-muted-foreground text-xs">
        Setting a custom command also writes the matching{" "}
        <code>difftool.&lt;tool&gt;.cmd</code> /{" "}
        <code>mergetool.&lt;tool&gt;.cmd</code> key (REQ-P5-CFG-003).
      </p>
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            if (diffToolVal !== "") onSave("diff.tool", diffToolVal);
            if (mergeToolVal !== "") onSave("merge.tool", mergeToolVal);
            if (diffToolVal !== "" && diffCmdVal !== "")
              onSave(`difftool.${diffToolVal}.cmd`, diffCmdVal);
            if (mergeToolVal !== "" && mergeCmdVal !== "")
              onSave(`mergetool.${mergeToolVal}.cmd`, mergeCmdVal);
          }}
        >
          Save tools
        </Button>
      </div>
    </section>
  );
}

function AdvancedConfigTable({
  entries,
  scope,
  busy,
  onSet,
  onUnset,
}: {
  entries: ReadonlyArray<GitConfigEntry>;
  scope: WritableScope;
  busy: boolean;
  onSet: (key: string, value: string) => void;
  onUnset: (key: string, scope: WritableScope) => void;
}) {
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">All config entries</h3>
      <div className="max-h-56 overflow-auto border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Key</TableHead>
              <TableHead>Value</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((e, i) => (
              <TableRow key={`${e.scope}:${e.key}:${i}`}>
                <TableCell className="font-mono text-xs">{e.key}</TableCell>
                <TableCell className="max-w-48 truncate font-mono text-xs">
                  {e.value}
                </TableCell>
                <TableCell>
                  <Badge tone="muted">{e.scope}</Badge>
                </TableCell>
                <TableCell className="text-right">
                  {e.scope === "global" || e.scope === "local" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`Unset ${e.key}`}
                      onClick={() => onUnset(e.key, e.scope as WritableScope)}
                    >
                      Unset
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex gap-2">
        <input
          className={FIELD}
          aria-label="New config key"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          placeholder="section.key"
          disabled={busy}
        />
        <input
          className={FIELD}
          aria-label="New config value"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          placeholder="value"
          disabled={busy}
        />
        <Button
          size="sm"
          disabled={busy || newKey.trim() === ""}
          onClick={() => {
            onSet(newKey.trim(), newValue);
            setNewKey("");
            setNewValue("");
          }}
        >
          Add ({scope})
        </Button>
      </div>
    </section>
  );
}

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePref; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

function AppSettingsTab() {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const settings = useAppSettings();
  const save = useSetAppSettings();

  // Working copy of user keybinding overrides (commandId → chord; "" clears a default).
  // Seed ONCE from the first resolved settings load; do NOT re-seed on later refetches
  // (e.g. the refetch a theme save triggers) or unsaved edits would be clobbered. The
  // dialog unmounts on close, so reopening re-seeds from the latest persisted state.
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const seeded = useRef(false);
  useEffect(() => {
    if (!seeded.current && settings.data !== undefined) {
      setOverrides(keybindingsToRecord(settings.data.keybindings));
      seeded.current = true;
    }
  }, [settings.data]);
  const [recording, setRecording] = useState<string | null>(null);

  // Stand the global keybinding dispatcher down while a chord is being captured, so
  // recording e.g. Mod+K doesn't ALSO fire its bound action over the dialog. Cleared on
  // unmount too, so closing the dialog mid-capture can't leave the dispatcher disabled
  // (REQ-P5-CFG-006/007).
  useEffect(() => {
    setKeybindingCaptureActive(recording !== null);
    return () => setKeybindingCaptureActive(false);
  }, [recording]);

  const effective = mergeBindings(overrides);
  const conflicts = findConflicts(effective);

  const persist = (next: Record<string, string>) => {
    setOverrides(next);
    save.mutate({
      keybindings: Object.entries(next).map(
        ([commandId, chord]) => new KeyBinding({ commandId, chord }),
      ),
    });
  };

  return (
    <div className="flex flex-col gap-5 py-2">
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Theme</h3>
        <RadioGroup
          aria-label="Theme"
          value={theme}
          onValueChange={(v) => {
            const next = (v ?? "system") as ThemePref;
            setTheme(next);
            save.mutate({ theme: next });
          }}
          className="flex gap-4"
        >
          {THEME_OPTIONS.map((opt) => (
            <label key={opt.value} className="flex items-center gap-2 text-sm">
              <RadioGroupItem
                value={opt.value}
                aria-label={`${opt.label} theme`}
              />
              {opt.label}
            </label>
          ))}
        </RadioGroup>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Keyboard shortcuts</h3>
          <Button
            size="sm"
            variant="outline"
            disabled={save.isPending}
            onClick={() => persist({})}
          >
            Reset to defaults
          </Button>
        </div>
        {conflicts.length > 0 && (
          <div
            role="alert"
            className="border-destructive/50 bg-destructive/10 text-destructive border px-2 py-1 text-xs"
          >
            The chord {conflicts[0]?.chord} is bound to more than one action.
            Resolve the conflict before it can take effect.
          </div>
        )}
        <div className="flex flex-col divide-y border">
          {KEYBINDING_COMMANDS.map((cmd) => {
            const chord = effective[cmd.id] ?? "";
            const isRecording = recording === cmd.id;
            return (
              <div
                key={cmd.id}
                className="flex items-center gap-2 px-2 py-1.5 text-sm"
              >
                <span className="flex-1">{cmd.label}</span>
                {isRecording ? (
                  <input
                    autoFocus
                    readOnly
                    aria-label={`Recording chord for ${cmd.label}`}
                    className="h-7 w-40 border px-2 text-xs"
                    placeholder="Press a chord…"
                    onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                      e.preventDefault();
                      const next = eventToChord(e);
                      if (next !== null) {
                        setOverrides((o) => ({ ...o, [cmd.id]: next }));
                        setRecording(null);
                      }
                    }}
                    onBlur={() => setRecording(null)}
                  />
                ) : (
                  <code className="bg-muted/40 w-40 border px-2 py-0.5 text-center text-xs">
                    {chord === ""
                      ? "—"
                      : chord === DEFAULT_KEYBINDINGS[cmd.id]
                        ? chord
                        : `${chord} *`}
                  </code>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Change ${cmd.label}`}
                  onClick={() => setRecording(cmd.id)}
                >
                  Change
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Clear ${cmd.label}`}
                  onClick={() => setOverrides((o) => ({ ...o, [cmd.id]: "" }))}
                >
                  Clear
                </Button>
              </div>
            );
          })}
        </div>
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={conflicts.length > 0 || save.isPending}
            onClick={() => persist(overrides)}
          >
            Save shortcuts
          </Button>
        </div>
      </section>
    </div>
  );
}
