import { Component, type ErrorInfo, type ReactNode } from 'react';

import { ConnectionFailureScreen } from './ConnectionFailureScreen';

interface Props {
    readonly endpoint: string;
    readonly onRetry: () => void;
    readonly children: ReactNode;
}

interface BoundaryState {
    readonly error: Error | undefined;
}

/** Render failures retain the endpoint and offer the same safe retry as transport failures. */
export class ConnectionErrorBoundary extends Component<Props, BoundaryState> {
    override state: BoundaryState = { error: undefined };

    static getDerivedStateFromError(error: Error): BoundaryState {
        return { error };
    }

    override componentDidCatch(_error: Error, _info: ErrorInfo): void {
        // Render errors stay local. Diagnostics never transmit this information.
    }

    override render() {
        if (this.state.error !== undefined)
            return (
                <ConnectionFailureScreen
                    endpoint={this.props.endpoint}
                    error={this.state.error.message}
                    onRetry={() => {
                        this.setState({ error: undefined });
                        this.props.onRetry();
                    }}
                />
            );
        return this.props.children;
    }
}
