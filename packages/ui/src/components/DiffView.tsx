import { type DiffFile } from "@cbranch/rpc-contract";
import { useEffect, useMemo, useState } from "react";
import {
  Decoration,
  Diff,
  type DiffType,
  Hunk,
  type HunkData,
  parseDiff,
  type RenderToken,
  tokenize,
} from "react-diff-view";

import { languageForPath, loadShikiRefractor } from "../lib/shiki-highlighter";
import { fileToUnifiedDiff } from "../lib/unified-diff";
import { useUiStore } from "../state/store";
import { Placeholder } from "./ui/placeholder";

// Read-only rendered diff (REQ-STACK-020/022): react-diff-view fed by the reconstructed
// unified-diff patch, in inline (unified) or side-by-side (split) layout, with Shiki
// syntax highlighting layered on via tokens (loaded on demand). Each hunk carries a scroll
// anchor (`hunk-<i>`) so the panel's next/prev-change navigation can reveal it.

// Paint Shiki color onto colored token nodes; defer everything else to the default renderer.
const renderToken: RenderToken = (token, defaultRender, index) => {
  const color = (token as { color?: string }).color;
  if (color) {
    return (
      <span key={index} style={{ color }}>
        {token.children
          ? token.children.map((child, i) => defaultRender(child, i))
          : (token as { value?: string }).value}
      </span>
    );
  }
  return defaultRender(token, index);
};

export function DiffView({
  file,
  diffView,
}: {
  readonly file: DiffFile;
  readonly diffView: "inline" | "split";
}) {
  const themePref = useUiStore((s) => s.theme);
  const parsedFile = useMemo(() => {
    try {
      return parseDiff(fileToUnifiedDiff(file))[0] ?? null;
    } catch {
      return null;
    }
  }, [file]);

  const [tokens, setTokens] = useState<ReturnType<typeof tokenize> | null>(
    null,
  );

  useEffect(() => {
    setTokens(null);
    if (!parsedFile || parsedFile.hunks.length === 0) return;
    const language = languageForPath(file.newPath || file.oldPath);
    if (!language) return;
    let cancelled = false;
    const dark =
      typeof document !== "undefined" &&
      document.documentElement.classList.contains("dark");
    void loadShikiRefractor({ language, dark }).then((refractor) => {
      if (cancelled || !refractor) return;
      try {
        setTokens(
          tokenize(parsedFile.hunks, { highlight: true, refractor, language }),
        );
      } catch {
        // highlighting is best-effort; fall back to plain text
      }
    });
    return () => {
      cancelled = true;
    };
  }, [parsedFile, file, themePref]);

  if (!parsedFile || parsedFile.hunks.length === 0) {
    return <Placeholder>No textual changes ({file.status}).</Placeholder>;
  }

  return (
    <Diff
      viewType={diffView === "split" ? "split" : "unified"}
      diffType={(parsedFile.type as DiffType) || "modify"}
      hunks={parsedFile.hunks}
      tokens={tokens}
      renderToken={renderToken}
      className="text-xs"
    >
      {(hunks: HunkData[]) =>
        hunks.flatMap((hunk, i) => [
          <Decoration key={`anchor-${i}`}>
            <span id={`hunk-${i}`} />
          </Decoration>,
          <Hunk key={`hunk-${i}`} hunk={hunk} />,
        ])
      }
    </Diff>
  );
}
