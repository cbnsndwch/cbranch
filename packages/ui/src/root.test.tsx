// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { type ComponentProps } from 'react';
import { describe, expect, test } from 'vitest';

import { ErrorBoundary } from './root';

describe('root route error boundary', () => {
    test('guides a stale workspace URL back to cbranch', () => {
        render(
            <ErrorBoundary
                {...({
                    error: {
                        status: 404,
                        statusText: 'Not Found',
                        data: null,
                        internal: false,
                    },
                } as ComponentProps<typeof ErrorBoundary>)}
            />,
        );

        expect(
            screen.getByRole('heading', {
                name: 'This workspace link no longer exists.',
            }),
        ).toBeTruthy();
        expect(
            screen
                .getByRole('link', { name: 'Return to cbranch' })
                .getAttribute('href'),
        ).toBe('/');
    });
});
