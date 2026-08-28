// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';

const { driver, tour } = vi.hoisted(() => {
    const tourDriver = {
        drive: vi.fn(),
        destroy: vi.fn(),
        moveNext: vi.fn(),
        movePrevious: vi.fn(),
        getActiveIndex: vi.fn(() => 0),
    };
    return { driver: vi.fn(() => tourDriver), tour: tourDriver };
});

vi.mock('driver.js', () => ({ driver }));

import {
    startWorkspaceIntelligenceTour,
    workspaceIntelligenceTourProgress,
} from './workspace-intelligence-tour';

describe('Workspace Intelligence first-use tour', () => {
    test('resumes an optional guide at its saved step without starting inference', () => {
        localStorage.setItem('cbranch.workspace-intelligence.tour-step', '1');
        const onProgressChange = vi.fn();

        startWorkspaceIntelligenceTour({
            hasReport: true,
            hasGenerationProfile: false,
            onProgressChange,
        });

        expect(driver).toHaveBeenCalledOnce();
        expect(tour.drive).toHaveBeenCalledWith(1);
        const options = driver.mock.calls[0]![0]!;
        expect(options.steps).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    element: '#workspace-intelligence-analysis',
                }),
                expect.objectContaining({
                    element: '#workspace-intelligence-setup-inference',
                }),
            ]),
        );
        expect(workspaceIntelligenceTourProgress()).toBe(1);
    });

    test('remembers progress only when the user advances the explanatory tour', () => {
        localStorage.clear();
        const onProgressChange = vi.fn();

        startWorkspaceIntelligenceTour({
            hasReport: false,
            hasGenerationProfile: false,
            onProgressChange,
        });

        const options = driver.mock.calls.at(-1)![0]!;
        options.onNextClick(undefined, options.steps![0]!, {
            index: 0,
            driver: tour,
        });

        expect(workspaceIntelligenceTourProgress()).toBe(1);
        expect(onProgressChange).toHaveBeenCalledWith(1);
        expect(tour.moveNext).toHaveBeenCalled();
    });
});
