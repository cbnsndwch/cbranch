// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';

import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from './tooltip';

afterEach(cleanup);

describe('TooltipContent', () => {
    test('places tooltips below their trigger by default', async () => {
        render(
            <TooltipProvider>
                <Tooltip defaultOpen>
                    <TooltipTrigger render={<button type="button" />}>
                        Open actions
                    </TooltipTrigger>
                    <TooltipContent>Open the action menu</TooltipContent>
                </Tooltip>
            </TooltipProvider>,
        );

        expect(
            (await screen.findByText('Open the action menu')).getAttribute(
                'data-side',
            ),
        ).toBe('bottom');
    });
});
