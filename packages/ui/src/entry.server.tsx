// Server entry (React Router 8 framework mode). Even though this app is a pure SPA
// (`ssr: false`, `prerender: false`), the framework renders the document ONCE at build
// time to emit the static `index.html` shell that the browser then hydrates. This module
// is that build-time renderer — it never runs at request time (there is no server).
//
// Providing our own entry.server keeps the build self-contained: RR does not need to infer
// a server runtime (and would otherwise auto-add `isbot` to package.json). Bot detection is
// irrelevant for a shell-only render, so this is a plain `renderToPipeableStream`.

import { PassThrough } from 'node:stream';

import { createReadableStreamFromReadable } from '@react-router/node';
import { renderToPipeableStream } from 'react-dom/server';
import { ServerRouter, type EntryContext } from 'react-router';

const ABORT_DELAY = 10_000;

export default function handleRequest(
    request: Request,
    responseStatusCode: number,
    responseHeaders: Headers,
    routerContext: EntryContext,
): Promise<Response> {
    return new Promise((resolve, reject) => {
        const { pipe, abort } = renderToPipeableStream(
            <ServerRouter context={routerContext} url={request.url} />,
            {
                onAllReady() {
                    const body = new PassThrough();
                    const stream = createReadableStreamFromReadable(body);
                    responseHeaders.set('Content-Type', 'text/html');
                    resolve(
                        new Response(stream, {
                            headers: responseHeaders,
                            status: responseStatusCode,
                        }),
                    );
                    pipe(body);
                },
                onShellError(error: unknown) {
                    reject(error);
                },
                onError(error: unknown) {
                    responseStatusCode = 500;
                    console.error(error);
                },
            },
        );

        setTimeout(abort, ABORT_DELAY);
    });
}
