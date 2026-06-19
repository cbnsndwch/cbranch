// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { emptyFilters } from "../lib/filters";
import { FilterBar } from "./FilterBar";

afterEach(() => cleanup());

describe("FilterBar (P1-UI-FILT-1/3)", () => {
  test("ref-scope buttons apply immediately", () => {
    const onChange = vi.fn();
    render(<FilterBar filters={emptyFilters} onChange={onChange} dateMode="relative" onDateModeChange={() => {}} />);
    fireEvent.click(screen.getByText("All"));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ refScope: "all" }));
  });

  test("text fields apply only on submit", () => {
    const onChange = vi.fn();
    const { container } = render(
      <FilterBar filters={emptyFilters} onChange={onChange} dateMode="relative" onDateModeChange={() => {}} />,
    );
    const author = screen.getByText("author").querySelector("input")!;
    fireEvent.change(author, { target: { value: "ada" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.submit(container.querySelector("form")!);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ author: "ada" }));
  });

  test("active filters render removable chips that clear on click (P1-FILT-6)", () => {
    const onChange = vi.fn();
    render(
      <FilterBar
        filters={{ ...emptyFilters, author: "ada" }}
        onChange={onChange}
        dateMode="relative"
        onDateModeChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText("Clear author: ada"));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ author: "" }));
  });

  test("the date toggle switches the preference (P1-HIST-8)", () => {
    const onDateModeChange = vi.fn();
    render(
      <FilterBar filters={emptyFilters} onChange={() => {}} dateMode="relative" onDateModeChange={onDateModeChange} />,
    );
    fireEvent.click(screen.getByText("absolute"));
    expect(onDateModeChange).toHaveBeenCalledWith("absolute");
  });
});
