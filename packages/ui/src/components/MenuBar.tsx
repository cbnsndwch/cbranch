const MENU_ITEMS = [
  "Start",
  "Repository",
  "Navigate",
  "View",
  "Commands",
  "GitHub",
  "Plugins",
  "Tools",
  "Help",
] as const;

export function MenuBar() {
  return (
    <div className="bg-background flex items-center border-b">
      {MENU_ITEMS.map((item) => (
        <button key={item} type="button" className="hover:bg-accent/50 h-full px-2 text-[11px]">
          {item}
        </button>
      ))}
    </div>
  );
}
