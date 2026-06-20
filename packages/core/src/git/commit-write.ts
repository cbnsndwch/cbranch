import { type CommitCreated, type CommitInput, type CommitMessage, type GitError, Oid } from "@cbranch/rpc-contract";
import { Effect } from "effect";

import { gitError } from "./errors";
import { runGit, runGitOk } from "./run-git";

// ASCII unit separator (0x1F) used as a delimiter in git --format strings so it
// cannot collide with characters in commit subjects.
const UNIT_SEP = String.fromCharCode(31);

export const commitCreate = (cwd: string, input: CommitInput): Effect.Effect<CommitCreated, GitError> =>
  Effect.gen(function* () {
    // Pre-flight: reject an empty index unless amending or allowEmpty is set.
    if (!input.amend && !input.allowEmpty) {
      const check = yield* runGit({ cwd, args: ["diff", "--cached", "--quiet"], read: false });
      if (check.exitCode === 0) {
        return yield* Effect.fail(gitError("gitFailed", "nothing to commit: no staged changes"));
      }
    }

    const args: string[] = ["commit", "-F", "-"];
    if (input.amend) args.push("--amend");
    if (input.signoff) args.push("--signoff");
    if (input.sign !== undefined) {
      args.push(input.sign.keyId !== undefined ? "-S" + input.sign.keyId : "-S");
    }
    if (input.authorOverride !== undefined) {
      args.push("--author=" + input.authorOverride.name + " <" + input.authorOverride.email + ">");
    }
    if (input.allowEmpty) args.push("--allow-empty");
    if (input.noVerify) args.push("--no-verify");

    const body = input.body;
    const message = input.subject + (body !== undefined && body !== "" ? "\n\n" + body : "");
    yield* runGitOk({ cwd, args, read: false, stdin: Buffer.from(message, "utf8") });

    const oidResult = yield* runGitOk({ cwd, args: ["rev-parse", "HEAD"], read: false });
    const oid = oidResult.stdout.toString("utf8").trim();

    const logFmt = "--format=%h" + UNIT_SEP + "%s";
    const logResult = yield* runGitOk({ cwd, args: ["log", "-1", logFmt], read: false });
    const parts = logResult.stdout.toString("utf8").trim().split(UNIT_SEP);
    const shortOid = parts[0] ?? "";
    const subject = parts[1] ?? input.subject;

    return { oid: Oid.make(oid), shortOid, subject };
  });

export const commitLastMessage = (cwd: string): Effect.Effect<CommitMessage, GitError> =>
  Effect.gen(function* () {
    const result = yield* runGit({ cwd, args: ["log", "-1", "--format=%B"], read: false });
    if (result.exitCode !== 0) {
      return yield* Effect.fail(gitError("repoUnavailable", "no commits yet"));
    }
    const raw = result.stdout.toString("utf8").trimEnd();
    const lines = raw.split("\n");
    const subject = lines[0] ?? "";
    const blankIdx = lines.indexOf("");
    const body =
      blankIdx >= 0
        ? lines
            .slice(blankIdx + 1)
            .join("\n")
            .trimEnd()
        : "";
    return { subject, body, raw };
  });
