// cbranch scripted rebase sequence editor (REQ-P5-IR-008).
//
// `git rebase -i` runs `GIT_SEQUENCE_EDITOR` through its own shell as
// `sh -c '<editor> "$@"' <editor> <todopath>`, appending the path of its generated
// `git-rebase-todo` as a positional argument. cbranch sets the editor to
// `"<node>" "<this file>"`, so this process is invoked as
// `node rebase-seq-editor.mjs <git-todo-path>` (the path arrives as argv[2]).
//
// We overwrite git's generated todo with the cbranch-authored todo whose path is
// passed via the `CBRANCH_REBASE_TODO` environment variable (env, never the shell),
// then exit. No human edits the todo; the rebase runs fully scripted. We exit
// non-zero on any problem so a misconfiguration aborts the rebase loudly rather than
// replaying git's default (unedited) todo.
import { readFileSync, writeFileSync } from "node:fs";

const gitTodoPath = process.argv[2];
const authoredPath = process.env.CBRANCH_REBASE_TODO;

if (
  gitTodoPath === undefined ||
  authoredPath === undefined ||
  authoredPath === ""
) {
  process.stderr.write(
    "cbranch rebase shim: missing todo path or CBRANCH_REBASE_TODO\n",
  );
  process.exit(1);
}

try {
  // Byte-for-byte copy: never decode/re-encode the authored todo.
  writeFileSync(gitTodoPath, readFileSync(authoredPath));
} catch (err) {
  process.stderr.write(`cbranch rebase shim: ${String(err)}\n`);
  process.exit(1);
}
