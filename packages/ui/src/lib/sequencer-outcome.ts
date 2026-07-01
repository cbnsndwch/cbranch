// Maps a cherry-pick / revert / continuation result to the UI's next step (P4 UI-C).
//
// The sequencer methods report an OUTCOME, not just success/error (DECISIONS D17): a
// partially-applied range stops on a conflict (keeping earlier commits) and an
// already-applied pick is empty rather than an error. This pure function translates that
// outcome into the single action the dialogs dispatch — show a success toast and close,
// route into the Conflicts view, or open the empty-result prompt — so the mapping is
// unit-testable in isolation from React (the components own the toast/navigation effects).

import { type Oid, type SequencerResult } from '@cbranch/rpc-contract';

export type SequencerAction =
    | { readonly kind: 'success'; readonly message: string }
    | { readonly kind: 'conflicts'; readonly message: string }
    | {
          readonly kind: 'empty';
          readonly currentOid?: Oid;
          readonly currentSubject?: string;
      };

const plural = (n: number): string => (n === 1 ? '' : 's');

/**
 * Translate a {@link SequencerResult} into the next UI step. `opLabel` is the
 * user-facing operation name ("Cherry-pick" / "Revert"), reused for continue/skip steps
 * since the underlying operation is unchanged.
 */
export function planSequencerAction(
    result: SequencerResult,
    opLabel: string,
): SequencerAction {
    switch (result.outcome) {
        case 'completed':
            return {
                kind: 'success',
                message:
                    result.committed > 0
                        ? `${opLabel} complete — ${result.committed} commit${plural(
                              result.committed,
                          )}.`
                        : `${opLabel} complete.`,
            };
        case 'staged':
            return {
                kind: 'success',
                message: `${opLabel} staged — commit it when you are ready.`,
            };
        case 'conflicts':
            return {
                kind: 'conflicts',
                message: `${opLabel} stopped on a conflict — resolve it in the Conflicts view.`,
            };
        case 'empty':
            return {
                kind: 'empty',
                currentOid: result.currentOid,
                currentSubject: result.currentSubject,
            };
    }
}
