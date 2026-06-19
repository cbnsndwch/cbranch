// Shiki syntax highlighting for the diff surface (REQ-STACK-022: Shiki is the single
// highlighter). Loaded ON DEMAND via dynamic import (REQ-STACK-019) so the grammars stay
// out of the initial bundle. The output is shaped as refractor-style hast nodes carrying a
// `color` so react-diff-view's `tokenize` can fold them into its line model, and a custom
// renderToken paints the color.
//
// TOOLING NOTE: the inter-line newline value is built from a char code, never typed as an
// escape (editor writes JSON-decode and would corrupt a literal "\n").

const NL = String.fromCharCode(10);
const LIGHT_THEME = "github-light";
const DARK_THEME = "github-dark";

// Extension → Shiki language id for the common cases; unknown types skip highlighting.
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "jsonc",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  vue: "vue",
  svelte: "svelte",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  rb: "ruby",
  php: "php",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  swift: "swift",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
  xml: "xml",
  lua: "lua",
  r: "r",
  dart: "dart",
  scala: "scala",
};

/** Resolve a Shiki language id from a file path, or null when the type is unknown. */
export const languageForPath = (path: string): string | null => {
  const base = (path.split("/").pop() ?? "").toLowerCase();
  if (base === "dockerfile") return "docker";
  if (base === "makefile") return "make";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  return EXT_TO_LANG[base.slice(dot + 1)] ?? null;
};

// One lazily-created highlighter, with languages loaded on demand as files are viewed.
export interface ShikiToken {
  readonly content: string;
  readonly color?: string;
}
interface ShikiHighlighter {
  codeToTokens(code: string, options: { lang: string; theme: string }): { tokens: ShikiToken[][] };
  loadLanguage(lang: string): Promise<void>;
  getLoadedLanguages(): string[];
}

let highlighterPromise: Promise<ShikiHighlighter> | null = null;
const requested = new Set<string>();

const getHighlighter = async (lang: string): Promise<ShikiHighlighter> => {
  if (!highlighterPromise) {
    requested.add(lang);
    // TODO(ui-D): the full `shiki` bundle pulls every grammar into the (lazy) chunk; a later
    // pass can switch to `createHighlighterCore` with fine-grained per-language imports to
    // shrink it. It is already isolated in its own on-demand chunk (REQ-STACK-019).
    highlighterPromise = import("shiki").then((m) =>
      m.createHighlighter({ themes: [LIGHT_THEME, DARK_THEME], langs: [lang] }),
    ) as Promise<ShikiHighlighter>;
    return highlighterPromise;
  }
  const highlighter = await highlighterPromise;
  if (!requested.has(lang)) {
    requested.add(lang);
    try {
      await highlighter.loadLanguage(lang);
    } catch {
      // unsupported language id — leave it unloaded; caller falls back to plain text
    }
  }
  return highlighter;
};

/**
 * Tokenize `code` into per-line Shiki tokens (content + color) for the CodeMirror
 * file-at-revision view (P1-UI-DIFF-3), or null when the language is unavailable / Shiki
 * fails (the view then shows plain, unhighlighted text). Reuses the same on-demand
 * highlighter as the diff surface (REQ-STACK-019/022).
 */
export const loadShikiLines = async ({
  code,
  language,
  dark,
}: {
  readonly code: string;
  readonly language: string;
  readonly dark: boolean;
}): Promise<ReadonlyArray<ReadonlyArray<ShikiToken>> | null> => {
  try {
    const highlighter = await getHighlighter(language);
    if (!highlighter.getLoadedLanguages().includes(language)) return null;
    const theme = dark ? DARK_THEME : LIGHT_THEME;
    return highlighter.codeToTokens(code, { lang: language, theme }).tokens;
  } catch {
    return null;
  }
};

/** A refractor-compatible highlighter that react-diff-view's `tokenize` can consume. */
export interface ShikiRefractor {
  highlight(text: string, language: string): unknown[];
}

/**
 * Load Shiki and return a refractor adapter for `language`/theme, or null when the language
 * is unavailable or Shiki fails to load (the diff then renders as plain text).
 */
export const loadShikiRefractor = async ({
  language,
  dark,
}: {
  readonly language: string;
  readonly dark: boolean;
}): Promise<ShikiRefractor | null> => {
  try {
    const highlighter = await getHighlighter(language);
    if (!highlighter.getLoadedLanguages().includes(language)) return null;
    const theme = dark ? DARK_THEME : LIGHT_THEME;
    return {
      highlight(text: string) {
        const { tokens } = highlighter.codeToTokens(text, { lang: language, theme });
        const nodes: unknown[] = [];
        tokens.forEach((line, index) => {
          for (const token of line) {
            nodes.push({
              type: "element",
              tagName: "span",
              color: token.color,
              children: [{ type: "text", value: token.content }],
            });
          }
          if (index < tokens.length - 1) nodes.push({ type: "text", value: NL });
        });
        return nodes;
      },
    };
  } catch {
    return null;
  }
};
