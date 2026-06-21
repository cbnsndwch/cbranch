import { Oid, SequencerResult } from "@cbranch/rpc-contract";
import { describe, expect, test } from "vitest";

import { planSequencerAction } from "./sequencer-outcome";

const result = (over: Partial<SequencerResult> = {}): SequencerResult =>
  new SequencerResult({
    outcome: "completed",
    operation: "cherryPick",
    committed: 1,
    ...over,
  });

describe("planSequencerAction", () => {
  test("completed with commits → success toast, singular vs plural", () => {
    expect(
      planSequencerAction(result({ committed: 1 }), "Cherry-pick"),
    ).toEqual({ kind: "success", message: "Cherry-pick complete — 1 commit." });
    expect(
      planSequencerAction(result({ committed: 3 }), "Cherry-pick"),
    ).toEqual({
      kind: "success",
      message: "Cherry-pick complete — 3 commits.",
    });
  });

  test("completed with zero commits omits the count (e.g. after a skip)", () => {
    expect(
      planSequencerAction(result({ committed: 0 }), "Cherry-pick"),
    ).toEqual({ kind: "success", message: "Cherry-pick complete." });
  });

  test("staged (--no-commit) → success without a commit", () => {
    const action = planSequencerAction(
      result({ outcome: "staged", committed: 0 }),
      "Revert",
    );
    expect(action.kind).toBe("success");
    expect(action).toMatchObject({
      message: expect.stringContaining("staged"),
    });
  });

  test("conflicts → route into the Conflicts view", () => {
    const action = planSequencerAction(
      result({
        outcome: "conflicts",
        committed: 0,
        currentOid: Oid.make("dead"),
      }),
      "Cherry-pick",
    );
    expect(action.kind).toBe("conflicts");
    expect(action).toMatchObject({
      message: expect.stringContaining("Conflicts view"),
    });
  });

  test("empty → carry the offending commit to the empty prompt", () => {
    const action = planSequencerAction(
      result({
        outcome: "empty",
        committed: 0,
        currentOid: Oid.make("c0ffee"),
        currentSubject: "already applied",
      }),
      "Cherry-pick",
    );
    expect(action).toEqual({
      kind: "empty",
      currentOid: "c0ffee",
      currentSubject: "already applied",
    });
  });
});
