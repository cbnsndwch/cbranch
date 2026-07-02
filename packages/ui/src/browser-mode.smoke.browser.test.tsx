import { useState } from 'react';
import { page, userEvent } from 'vitest/browser';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from './components/ui/select';

// Browser-mode foundation smoke test (runs ONLY via `pnpm test:browser`, in a real
// headless Chromium). It is the load-bearing proof for the whole rig: committing a
// value on the vendored Base UI `Select` is geometry-gated and is IMPOSSIBLE to drive
// in jsdom (verified — every fireEvent/user-event path leaves onValueChange uncalled).
// Here it works, because the browser lays the popup out for real. This file also serves
// as the reference pattern future component tests copy when they need real interaction:
//   • render from `vitest-browser-react`
//   • page-scoped locators from `@vitest/browser/context` (they see portaled popups)
//   • `userEvent` from `@vitest/browser/context` (drives the real browser)
// Do NOT add `// @vitest-environment` — browser mode is set by vitest.browser.config.ts,
// and the `.browser.test.tsx` name keeps it out of the fast node/jsdom runner.

function Harness({ onChange }: { onChange: (v: string) => void }) {
    const [value, setValue] = useState('a');
    return (
        <Select
            value={value}
            onValueChange={v => {
                setValue(v ?? 'a');
                onChange(v ?? 'a');
            }}
        >
            <SelectTrigger aria-label="Fruit">
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                <SelectItem value="a">Apple</SelectItem>
                <SelectItem value="b">Banana</SelectItem>
            </SelectContent>
        </Select>
    );
}

test('a real Select commits a non-default value (the jsdom-impossible interaction)', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    // Open the popup and pick the non-default option — the exact flow jsdom can't run.
    await userEvent.click(page.getByRole('combobox', { name: 'Fruit' }));
    await userEvent.click(page.getByRole('option', { name: 'Banana' }));

    // The callback fires with the chosen value — THE assertion that is impossible to
    // satisfy in jsdom (there, onValueChange never fires for any interaction).
    expect(onChange).toHaveBeenCalledWith('b');
    // …and the controlled trigger reflects the new selection. (Base UI's SelectValue
    // renders the raw value here — `b` — not the "Banana" label; label mapping is a
    // component concern for the follow-up, irrelevant to proving the interaction ran.)
    await expect
        .element(page.getByRole('combobox', { name: 'Fruit' }))
        .toHaveTextContent('b');
});
