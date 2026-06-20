// A full-window "coming soon" page for navigation surfaces whose URL namespace is staked
// now but whose UI lands in a later milestone (branches, tags, worktrees, stash, blame).
export function PlaceholderPage({ title }: { readonly title: string }) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-2 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-muted-foreground text-xs">
        Coming in a later milestone.
      </p>
    </div>
  );
}
