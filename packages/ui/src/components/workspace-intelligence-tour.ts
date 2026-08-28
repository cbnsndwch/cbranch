import { driver, type DriveStep } from 'driver.js';

const TOUR_STORAGE_KEY = 'cbranch.workspace-intelligence.tour-step';

interface WorkspaceIntelligenceTourOptions {
    readonly hasReport: boolean;
    readonly hasGenerationProfile: boolean;
    readonly onProgressChange: (step: number | undefined) => void;
}

const readProgress = (): number | undefined => {
    try {
        const value = Number(localStorage.getItem(TOUR_STORAGE_KEY));
        return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    } catch {
        return undefined;
    }
};

const writeProgress = (step: number | undefined): void => {
    try {
        if (step === undefined) localStorage.removeItem(TOUR_STORAGE_KEY);
        else localStorage.setItem(TOUR_STORAGE_KEY, String(step));
    } catch {
        // Local storage is an optional convenience; never block the guide for it.
    }
};

export const workspaceIntelligenceTourProgress = (): number | undefined =>
    readProgress();

/**
 * A deliberately optional tour. It only explains and highlights controls; it never
 * starts a run, saves a profile, or invokes inference on behalf of the user.
 */
export const startWorkspaceIntelligenceTour = ({
    hasReport,
    hasGenerationProfile,
    onProgressChange,
}: WorkspaceIntelligenceTourOptions): void => {
    const steps: DriveStep[] = [
        {
            element: '#workspace-intelligence-analysis',
            popover: {
                title: 'Start with deterministic analysis',
                description:
                    'Analyze workspace reads the selected repositories and creates a durable, read-only architecture report. It does not call an AI provider.',
            },
        },
        ...(hasReport
            ? [
                  {
                      element: '#workspace-intelligence-report',
                      popover: {
                          title: 'Understand the completed report',
                          description:
                              'Coverage, findings, and the bounded graph preview explain what completed. Download the full artifact when you need every record.',
                      },
                  },
                  {
                      element: '#workspace-intelligence-enrichment',
                      popover: {
                          title: 'AI enrichment is optional',
                          description:
                              'Inference is always a separate, explicit action. It uses bounded graph evidence and never changes the deterministic report.',
                      },
                  },
              ]
            : []),
        hasGenerationProfile
            ? {
                  element: '#workspace-intelligence-run-enrichment',
                  popover: {
                      title: 'Run enrichment when you are ready',
                      description:
                          'Choose the enabled generation profile, then explicitly run enrichment. Review and prefer its inferred relationships separately.',
                  },
              }
            : {
                  element: '#workspace-intelligence-setup-inference',
                  popover: {
                      title: 'Set up optional AI enrichment',
                      description:
                          'Use this action to open Inference settings. Detect a local tool or add a compatible endpoint, then choose a model and named credential reference before enabling it.',
                  },
                  disableActiveInteraction: false,
              },
    ];
    const savedStep = readProgress();
    const firstStep = Math.min(savedStep ?? 0, Math.max(steps.length - 1, 0));
    let completed = false;
    const remember = (step: number | undefined) => {
        writeProgress(step);
        onProgressChange(step);
    };
    const tour = driver({
        steps,
        showProgress: true,
        allowClose: true,
        skipMissingElement: true,
        popoverClass: 'cbranch-workspace-intelligence-tour',
        onNextClick: (_element, _step, options) => {
            const next = (options.index ?? 0) + 1;
            if (next >= steps.length) {
                completed = true;
                remember(undefined);
                options.driver.destroy();
                return;
            }
            remember(next);
            options.driver.moveNext();
        },
        onPrevClick: (_element, _step, options) => {
            const previous = Math.max((options.index ?? 0) - 1, 0);
            remember(previous);
            options.driver.movePrevious();
        },
        onDestroyed: (_element, _step, options) => {
            if (!completed)
                remember(options.driver.getActiveIndex() ?? savedStep ?? 0);
        },
    });
    tour.drive(firstStep);
};
