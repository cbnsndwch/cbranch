import { Button } from './ui/button';

export function ConnectionFailureScreen({
    endpoint,
    error,
    onRetry,
}: {
    readonly endpoint: string;
    readonly error?: string;
    readonly onRetry: () => void;
}) {
    return (
        <main className="grid min-h-dvh place-items-center bg-muted/20 p-4">
            <section className="w-full max-w-lg border bg-background p-6 shadow-sm">
                <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                    Connection failed
                </p>
                <h1 className="mt-2 text-xl font-semibold">
                    cbranch is unavailable
                </h1>
                <p role="alert" className="mt-3 text-sm">
                    {error ??
                        'The cbranch backend did not accept the connection.'}
                </p>
                <p className="text-muted-foreground mt-4 break-all font-mono text-xs">
                    {endpoint}
                </p>
                <Button className="mt-5" onClick={onRetry}>
                    Retry connection
                </Button>
            </section>
        </main>
    );
}
