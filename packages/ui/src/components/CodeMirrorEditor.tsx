// A minimal editable CodeMirror 6 host (REQ-P6-META-005 — plain-text editing). CodeMirror
// is loaded ON DEMAND via dynamic import (REQ-STACK-019) so it stays out of the main bundle,
// mirroring the read-only viewer in FileAtRevision. The editor is UNCONTROLLED after mount:
// it initializes from `initialValue` and reports edits through `onChange`. Callers that need
// to reset the document (e.g. switching files) remount it with a changed `key`.

import { useEffect, useRef } from 'react';

export function CodeMirrorEditor({
    initialValue,
    onChange,
    ariaLabel,
}: {
    readonly initialValue: string;
    readonly onChange: (value: string) => void;
    readonly ariaLabel?: string;
}) {
    const hostRef = useRef<HTMLDivElement>(null);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;

    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        let cancelled = false;
        let view: { destroy(): void } | null = null;

        void (async () => {
            const [{ EditorState }, { EditorView, lineNumbers, keymap }] =
                await Promise.all([
                    import('@codemirror/state'),
                    import('@codemirror/view'),
                ]);
            const { defaultKeymap, history, historyKeymap } =
                await import('@codemirror/commands');
            if (cancelled) return;

            const state = EditorState.create({
                doc: initialValue,
                extensions: [
                    lineNumbers(),
                    history(),
                    keymap.of([...defaultKeymap, ...historyKeymap]),
                    EditorView.updateListener.of(update => {
                        if (update.docChanged)
                            onChangeRef.current(update.state.doc.toString());
                    }),
                    EditorView.theme({
                        '&': { height: '100%', fontSize: '12px' },
                        '.cm-scroller': {
                            fontFamily:
                                'var(--font-mono, ui-monospace, monospace)',
                        },
                    }),
                ],
            });
            view = new EditorView({ state, parent: host });
        })();

        return () => {
            cancelled = true;
            view?.destroy();
            host.replaceChildren();
        };
        // Build once per mount; a changed document arrives via a new `key` from the caller.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div
            ref={hostRef}
            aria-label={ariaLabel}
            className="h-full overflow-auto"
        />
    );
}
