import { Menu, Notice } from "obsidian";
import { t } from "../i18n";

export interface LibraryMenuAction { label: string; icon: string; run: () => unknown; }
/** One menu for mouse, touch/pen hold and the visible overflow button. */
export function bindLibraryMenu(host: HTMLElement, actions: () => LibraryMenuAction[]): { open: (x: number, y: number) => void; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined, pointer = -1, x = 0, y = 0, suppressed = 0, menu: Menu | null = null, disposed = false;
  const doc = host.ownerDocument;
  const stopTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const cancel = () => {
    stopTimer(); pointer = -1;
    if (suppressed === Infinity) suppressed = Date.now() + 700;
    doc.removeEventListener("pointermove", move); doc.removeEventListener("pointerup", up); doc.removeEventListener("pointercancel", up);
    doc.removeEventListener("scroll", cancel, true); doc.defaultView?.removeEventListener("blur", cancel);
  };
  const open = (x: number, y: number) => {
    if (disposed) return;
    stopTimer(); menu?.hide(); menu = new Menu();
    for (const action of actions()) menu.addItem(item => item.setTitle(action.label).setIcon(action.icon).onClick(() => {
      void Promise.resolve().then(() => { if (!disposed) return action.run(); }).catch(() => new Notice(t("library.failed")));
    }));
    menu.showAtPosition({ x, y });
  };
  const context = (event: MouseEvent) => {
    event.preventDefault(); event.stopPropagation();
    if (Date.now() >= suppressed) { if (pointer !== -1) suppressed = Infinity; open(event.clientX, event.clientY); }
  };
  const down = (event: PointerEvent) => {
    cancel(); if (event.pointerType !== "touch" && event.pointerType !== "pen" || !event.isPrimary) return;
    if ((event.target as Element).closest("a, input, .mw-svg-action, .mw-cloud__link")) return;
    suppressed = 0; pointer = event.pointerId; x = event.clientX; y = event.clientY;
    doc.addEventListener("pointermove", move); doc.addEventListener("pointerup", up); doc.addEventListener("pointercancel", up);
    doc.addEventListener("scroll", cancel, true); doc.defaultView?.addEventListener("blur", cancel);
    timer = setTimeout(() => { suppressed = Infinity; open(x, y); }, 450);
  };
  const move = (event: PointerEvent) => { if (event.pointerId === pointer && Math.hypot(event.clientX - x, event.clientY - y) > 12) cancel(); };
  const up = (event: PointerEvent) => { if (event.pointerId === pointer) cancel(); };
  const click = (event: MouseEvent) => { if (event.detail !== 0 && Date.now() < suppressed) { event.preventDefault(); event.stopImmediatePropagation(); } };
  host.addEventListener("contextmenu", context); host.addEventListener("pointerdown", down); host.addEventListener("click", click, true);
  return { open, dispose: () => {
    disposed = true; cancel(); menu?.hide(); host.removeEventListener("contextmenu", context); host.removeEventListener("pointerdown", down); host.removeEventListener("click", click, true);
  } };
}
