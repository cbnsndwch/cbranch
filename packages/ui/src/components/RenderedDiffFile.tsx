import { type DiffFile } from '@cbranch/rpc-contract';

import { isLargeDiff, isSubmodule } from '../lib/diff';
import { BinaryCard, LargeDiffCard, SubmoduleCard } from './DiffPlaceholders';
import { DiffView } from './DiffView';

// Routes one DiffFile to the right presentation (P1-DIFF-8/9/10): a binary or submodule card,
// the deferred large-diff gate ("Load anyway"), or the rendered patch. `forced` is controlled
// by the caller so each diff surface keeps its own deferral memory — the commit diff panel
// tracks a per-file Set, the file-history viewer a single boolean — while the binary/submodule/
// large branching stays in one place so the two surfaces can't diverge (REQ-FH-003 parity).
export function RenderedDiffFile({
    file,
    diffView,
    forced,
    onForce,
}: {
    readonly file: DiffFile;
    readonly diffView: 'inline' | 'split';
    readonly forced: boolean;
    readonly onForce: () => void;
}) {
    if (file.isBinary) return <BinaryCard file={file} />;
    if (isSubmodule(file)) return <SubmoduleCard file={file} />;
    if (isLargeDiff(file) && !forced)
        return <LargeDiffCard file={file} onLoad={onForce} />;
    return <DiffView file={file} diffView={diffView} />;
}
