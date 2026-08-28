import { page, userEvent } from 'vitest/browser';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { App } from './App';

test('drills, traces a packet, and zooms in a real browser', async () => {
    render(<App />);

    await expect
        .element(page.getByText('Representative packets · no telemetry'))
        .toBeVisible();
    await userEvent.click(
        page.getByRole('button', { name: /Goal supervisor/ }).first(),
    );
    await userEvent.click(
        page.getByRole('button', { name: /Explore internals/ }),
    );

    await expect
        .element(page.getByText('CLI · TUI · MCP · host plugin').first())
        .toBeVisible();
    await userEvent.click(page.getByRole('button', { name: 'Trace one step' }));
    await expect.element(page.getByLabelText('Flow is paused')).toBeVisible();
    await expect
        .element(page.getByText('Representative payload'))
        .toBeVisible();

    await userEvent.click(page.getByRole('button', { name: 'Zoom in' }));
    await expect.element(page.getByLabelText('Map zoom 114%')).toBeVisible();

    await userEvent.click(
        page.getByRole('button', { name: 'Back to previous system map' }),
    );
    await expect
        .element(page.getByRole('button', { name: 'System', exact: true }))
        .toHaveAttribute('aria-current', 'page');
});
