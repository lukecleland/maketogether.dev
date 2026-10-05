import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface DawMenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
  shortcut?: string;
  danger?: boolean;
}
export function DawMenu({
  x,
  y,
  title,
  items,
  onClose,
}: {
  x: number;
  y: number;
  title: string;
  items: DawMenuItem[];
  onClose: (restoreFocus?: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    node.style.maxWidth = `${width - 16}px`;
    node.style.maxHeight = `${height - 16}px`;
    const rect = node.getBoundingClientRect();
    node.style.left = `${Math.max(left + 8, Math.min(x, left + width - rect.width - 8))}px`;
    node.style.top = `${Math.max(top + 8, Math.min(y, top + height - rect.height - 8))}px`;
    node.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y, title]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const dismiss = () => onClose();
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", dismiss);
    window.visualViewport?.addEventListener("resize", dismiss);
    window.visualViewport?.addEventListener("scroll", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", dismiss);
      window.visualViewport?.removeEventListener("resize", dismiss);
      window.visualViewport?.removeEventListener("scroll", dismiss);
    };
  }, [onClose]);
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={title}
      className="fixed z-[10000] max-h-[calc(100vh-16px)] w-64 overflow-auto rounded-lg border border-zinc-600 bg-zinc-900 p-1 text-xs text-zinc-200 shadow-2xl"
      style={{ left: x, top: y }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        const buttons = [
          ...(ref.current?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ) ?? []),
        ];
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        if (e.key === "Escape" || e.key === "Tab") {
          e.preventDefault();
          onClose(true);
        } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          const next =
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? buttons.length - 1
                : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                  buttons.length;
          buttons[next]?.focus();
        }
      }}
    >
      <div className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
        {title}
      </div>
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          disabled={item.disabled}
          className={`flex w-full items-center justify-between gap-4 rounded px-2 py-2 text-left outline-none hover:bg-zinc-700 focus:bg-zinc-700 disabled:opacity-35 ${item.danger ? "text-red-300" : ""}`}
          onClick={() => {
            onClose(true);
            item.action();
          }}
        >
          <span>{item.label}</span>
          {item.shortcut && (
            <kbd className="text-[10px] text-zinc-500">{item.shortcut}</kbd>
          )}
        </button>
      ))}
    </div>,
    document.body,
  );
}
