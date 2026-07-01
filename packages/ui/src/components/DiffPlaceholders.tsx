import { type DiffFile } from '@cbranch/rpc-contract';

import { changedLineCount, filePath } from '../lib/diff';
import { shortOid } from '../lib/format';

// Distinct, clearly-labeled placeholder cards for diffs that are not rendered as text
// (P1-UI-DIFF-4): binary changes (P1-DIFF-8), submodule/gitlink changes (P1-DIFF-10), and
// deferred large diffs (P1-DIFF-9, with a "Load anyway" action).

function Card({
    title,
    children,
}: {
    readonly title: string;
    readonly children?: React.ReactNode;
}) {
    return (
        <div className="m-3 border p-4 text-xs">
            <div className="text-foreground font-medium">{title}</div>
            {children ? (
                <div className="text-muted-foreground mt-1">{children}</div>
            ) : null}
        </div>
    );
}

export function BinaryCard({ file }: { readonly file: DiffFile }) {
    return (
        <Card title="Binary file">
            {filePath(file)} changed ({file.status}); not shown as text.
        </Card>
    );
}

export function SubmoduleCard({ file }: { readonly file: DiffFile }) {
    return (
        <Card title="Submodule">
            <div>{filePath(file)}</div>
            <div className="mt-1 font-mono">
                {file.oldOid ? shortOid(file.oldOid) : '—'} →{' '}
                {file.newOid ? shortOid(file.newOid) : '—'}
            </div>
        </Card>
    );
}

export function LargeDiffCard({
    file,
    onLoad,
}: {
    readonly file: DiffFile;
    readonly onLoad: () => void;
}) {
    return (
        <Card title="Large diff deferred">
            <div>
                {filePath(file)} has {changedLineCount(file)} changed lines and
                is not rendered automatically.
            </div>
            <button
                type="button"
                onClick={onLoad}
                className="hover:bg-accent mt-2 border px-2 py-0.5"
            >
                Load anyway
            </button>
        </Card>
    );
}
