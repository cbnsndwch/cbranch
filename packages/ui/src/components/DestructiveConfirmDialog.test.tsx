// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DestructiveConfirmDialog } from "./DestructiveConfirmDialog";

afterEach(() => cleanup());

describe("DestructiveConfirmDialog", () => {
  test("not rendered when open=false", () => {
    render(
      <DestructiveConfirmDialog
        open={false}
        onOpenChange={vi.fn()}
        title="Delete file"
        description="This cannot be undone."
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.queryByText("Delete file")).toBeNull();
  });

  test("shows title and description when open=true", () => {
    render(
      <DestructiveConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        title="Delete file"
        description="This cannot be undone."
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText("Delete file")).toBeTruthy();
    expect(screen.getByText("This cannot be undone.")).toBeTruthy();
  });

  test("cancel calls onOpenChange(false) without calling onConfirm", () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    render(
      <DestructiveConfirmDialog
        open={true}
        onOpenChange={onOpenChange}
        title="Discard changes"
        description="All changes will be lost."
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByText("Cancel"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("confirm button calls onConfirm and closes dialog", () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    render(
      <DestructiveConfirmDialog
        open={true}
        onOpenChange={onOpenChange}
        title="Discard changes"
        description="All changes will be lost."
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByText("Confirm"));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("custom confirmLabel renders on confirm button", () => {
    render(
      <DestructiveConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        title="Delete branch"
        description="Branch will be deleted."
        confirmLabel="Delete"
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText("Delete")).toBeTruthy();
    expect(screen.queryByText("Confirm")).toBeNull();
  });
});
