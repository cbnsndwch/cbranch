// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { App } from './App';

beforeEach(() => {
    vi.stubGlobal(
        'requestAnimationFrame',
        vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('system map interactions', () => {
    test('synchronizes outline search, map selection, and source inspector', async () => {
        const user = userEvent.setup();
        render(<App />);

        const outline = screen.getByRole('complementary', {
            name: 'System outline',
        });
        await user.type(
            within(outline).getByPlaceholderText('Search nodes or source…'),
            'GitEngine',
        );

        await user.click(
            within(outline).getByRole('button', { name: /GitEngine/ }),
        );

        const inspector = screen.getByRole('complementary', {
            name: 'System inspector',
        });
        expect(
            within(inspector).getByRole('heading', { name: 'GitEngine' }),
        ).not.toBeNull();

        await user.click(
            within(inspector).getByRole('tab', { name: 'How it’s built' }),
        );
        expect(within(inspector).getByText('Source evidence')).not.toBeNull();
        expect(
            within(inspector).getAllByText(/packages\/core\/src\/engine\//)
                .length,
        ).toBeGreaterThan(0);
    });

    test('drills into a subsystem and returns through the breadcrumb', async () => {
        const user = userEvent.setup();
        render(<App />);

        const outline = screen.getByRole('complementary', {
            name: 'System outline',
        });
        await user.click(
            within(outline).getByRole('button', { name: /Goal supervisor/ }),
        );
        await user.click(
            screen.getByRole('button', { name: /Explore internals/ }),
        );

        expect(
            screen.getByRole<HTMLButtonElement>('button', {
                name: 'Supervisor',
                current: 'page',
            }).disabled,
        ).toBe(true);
        expect(
            screen.getAllByText('CLI · TUI · MCP · host plugin').length,
        ).toBeGreaterThan(0);

        await user.click(
            screen.getByRole('button', { name: 'Back to previous system map' }),
        );
        expect(
            screen.getByRole<HTMLButtonElement>('button', {
                name: 'System',
                current: 'page',
            }).disabled,
        ).toBe(true);
        expect(screen.getAllByText('Node host service').length).toBeGreaterThan(
            0,
        );
    });

    test('pauses on one representative hop and resets the view', async () => {
        const user = userEvent.setup();
        render(<App />);

        await user.click(
            screen.getByRole('button', { name: 'Trace one step' }),
        );
        expect(screen.getByLabelText('Flow is paused')).not.toBeNull();
        expect(screen.getByText('Representative payload')).not.toBeNull();
        expect(
            screen.getByText(/not captured runtime telemetry/i),
        ).not.toBeNull();

        await user.click(screen.getByRole('button', { name: 'Reset view' }));
        expect(screen.getByLabelText('Flow is moving')).not.toBeNull();
        expect(
            screen.getByRole('heading', { name: 'Node host service' }),
        ).not.toBeNull();
    });

    test('supports keyboard tab navigation in the inspector', async () => {
        const user = userEvent.setup();
        render(<App />);

        const purpose = screen.getByRole('tab', { name: 'What it does' });
        const implementation = screen.getByRole('tab', {
            name: 'How it’s built',
        });
        purpose.focus();
        await user.keyboard('{ArrowRight}');

        expect(implementation.getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(implementation);
        expect(
            screen.getByRole('tabpanel').getAttribute('aria-labelledby'),
        ).toBe(implementation.id);
    });

    test('reports the animated direction for reverse packet routes', async () => {
        const user = userEvent.setup();
        render(<App />);

        const trace = screen.getByRole('button', { name: 'Trace one step' });
        await user.click(trace);
        await user.click(trace);
        await user.click(trace);
        await user.click(trace);
        await user.click(screen.getByRole('tab', { name: 'How it’s built' }));

        const route = screen.getByText('Route segment')
            .nextElementSibling as HTMLElement;
        expect(
            within(route)
                .getAllByRole('button')
                .map(button => button.textContent),
        ).toEqual(['GitEngine', 'Node host service']);
    });

    test('does not auto-play when reduced motion is requested', async () => {
        const user = userEvent.setup();
        vi.stubGlobal('matchMedia', (query: string) => ({
            matches: query === '(prefers-reduced-motion: reduce)',
            media: query,
            onchange: null,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            addListener: vi.fn(),
            removeListener: vi.fn(),
            dispatchEvent: vi.fn(),
        }));

        render(<App />);
        expect(screen.getByLabelText('Flow is paused')).not.toBeNull();
        expect(requestAnimationFrame).not.toHaveBeenCalled();

        await user.click(screen.getByRole('button', { name: 'Resume flow' }));
        expect(screen.getByLabelText('Flow is moving')).not.toBeNull();
        await user.click(screen.getByRole('button', { name: 'Reset view' }));
        expect(screen.getByLabelText('Flow is paused')).not.toBeNull();
    });
});
