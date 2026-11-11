/** Suppress native hover hints while preserving accessible control names. */
export function suppressHoverHints(event: MouseEvent): void {
  const target = event.target as Element | null;
  if (!target || typeof target.closest !== "function") return;
  const scope = target.closest(".mw-view, .mw-modal-zoom, .mw-settings");
  if (!scope) return;
  for (let element: Element | null = target; element; element = element.parentElement) {
    element.removeAttribute("title");
    if (element === scope) break;
  }
}
