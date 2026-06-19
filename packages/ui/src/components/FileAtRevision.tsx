import { type DownloadDescriptor, type FileContentResult, type RepoId } from "@cbranch/rpc-contract";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { languageForPath, loadShikiLines } from "../lib/shiki-highlighter";
import { useFileContentAtRev } from "../rpc/hooks";
import { useUiStore } from "../state/store";
import { Placeholder } from "./ui/placeholder";

// "View file at revision" (P1-DIFF-7 / P1-UI-DIFF-3): the full file content at a commit in a
// READ-ONLY CodeMirror 6 view with line numbers and Shiki syntax highlighting. CodeMirror is
// loaded ON DEMAND via dynamic import (REQ-STACK-019) so the editor stays out of the main
// bundle. Shiki remains the single highlighter (REQ-STACK-022); its per-line tokens are
// folded into CodeMirror as decorations (the `@shikijs/codemirror` adapter is unavailable in
// this registry, so the token→decoration bridge is done directly). Read-only only — no
// staging/editing affordances (P1-DIFF-12).

const isDownload = (result: FileContentResult): result is DownloadDescriptor => "url" in result;

export function FileAtRevision({
  repoId,
  rev,
  path,
}: {
  readonly repoId: RepoId;
  readonly rev: string;
  readonly path: string;
}) {
  const { data, isLoading, isError } = useFileContentAtRev(repoId, rev, path);
  const theme = useUiStore((s) => s.theme);
  const hostRef = useRef<HTMLDivElement>(null);

  const inline = data && !isDownload(data) ? data : null;
  const inlineUtf8 = inline && inline.encoding === "utf8" ? inline : null;
  const content = inlineUtf8?.content ?? "";

  useEffect(() => {
    if (isError) toast.error(`Could not load ${path} at this revision.`);
  }, [isError, path]);

  // Build the read-only editor when (and only when) we have inline text. Dynamic imports keep
  // CodeMirror + Shiki in their own on-demand chunks.
  useEffect(() => {
    if (inlineUtf8 === null) return;
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let view: { destroy(): void } | null = null;

    void (async () => {
      const [{ EditorState, StateField, RangeSetBuilder }, { EditorView, lineNumbers, Decoration }] = await Promise.all(
        [import("@codemirror/state"), import("@codemirror/view")],
      );
      if (cancelled) return;

      const language = languageForPath(path);
      const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
      const lines = language ? await loadShikiLines({ code: content, language, dark }) : null;
      if (cancelled) return;

      const state = EditorState.create({ doc: content });
      const builder = new RangeSetBuilder<ReturnType<typeof Decoration.mark>>();
      if (lines) {
        for (let i = 0; i < lines.length && i < state.doc.lines; i++) {
          const docLine = state.doc.line(i + 1);
          let col = 0;
          for (const token of lines[i]!) {
            const len = token.content.length;
            const from = docLine.from + col;
            const to = from + len;
            if (token.color && token.content.trim().length > 0 && to <= docLine.to) {
              builder.add(from, to, Decoration.mark({ attributes: { style: `color:${token.color}` } }));
            }
            col += len;
          }
        }
      }
      const decorations = builder.finish();
      const highlight = StateField.define({
        create: () => decorations,
        update: (value) => value,
        provide: (field) => EditorView.decorations.from(field),
      });

      const fullState = EditorState.create({
        doc: content,
        extensions: [
          lineNumbers(),
          EditorView.editable.of(false),
          EditorState.readOnly.of(true),
          highlight,
          EditorView.theme({
            "&": { height: "100%", fontSize: "12px" },
            ".cm-scroller": { fontFamily: "var(--font-mono, ui-monospace, monospace)" },
          }),
        ],
      });
      view = new EditorView({ state: fullState, parent: host });
    })();

    return () => {
      cancelled = true;
      view?.destroy();
      host.replaceChildren();
    };
  }, [inlineUtf8, content, path, theme]);

  if (isLoading) return <Placeholder>Loading file…</Placeholder>;
  if (isError || !data) return <Placeholder tone="danger">Could not load this file.</Placeholder>;

  if (isDownload(data)) {
    return (
      <div className="m-3 border p-4 text-xs">
        <div className="text-foreground font-medium">File too large to display inline</div>
        <div className="text-muted-foreground mt-1">{data.size} bytes.</div>
        <a href={data.url} className="text-primary mt-2 inline-block hover:underline">
          Download file
        </a>
      </div>
    );
  }

  if (data.encoding === "base64") {
    return (
      <div className="m-3 border p-4 text-xs">
        <div className="text-foreground font-medium">Binary file</div>
        <div className="text-muted-foreground mt-1">{data.size} bytes; not shown as text.</div>
      </div>
    );
  }

  return <div ref={hostRef} className="h-full overflow-auto" />;
}
