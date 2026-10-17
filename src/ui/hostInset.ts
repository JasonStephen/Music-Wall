/** Keep this pane's controls clear of Obsidian's floating status bar. */
export function watchHostInset(root: HTMLElement): () => void {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  if (!win) return () => {};
  let status: HTMLElement | null = null;
  let disposed = false;
  let frame = 0;
  let previous = -1;
  const refresh = () => {
    frame = 0;
    if (disposed) return;
    const next = doc.querySelector<HTMLElement>(".status-bar");
    if (next !== status) {
      if (status) resize?.unobserve(status);
      status = next;
      if (status) resize?.observe(status);
    }
    const pane = root.getBoundingClientRect();
    const bar = status?.getBoundingClientRect();
    const zoom = Number(win.getComputedStyle(root).getPropertyValue("--mw-zoom")) || 1;
    const overlaps = bar && bar.width > 0 && bar.height > 0 &&
      win.getComputedStyle(status!).visibility !== "hidden" &&
      bar.left < pane.right && bar.right > pane.left && bar.top < pane.bottom && bar.bottom > pane.top;
    const inset = overlaps ? Math.ceil((Math.min(pane.height, pane.bottom - bar!.top) + 6) / zoom) : 0;
    if (inset !== previous) { previous = inset; root.style.setProperty("--mw-host-bottom", `${inset}px`); }
  };
  const schedule = () => { if (!frame && !disposed) frame = win.requestAnimationFrame(refresh); };
  const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
  resize?.observe(root);
  // The status bar can grow with plugin items, be hidden, or move during pane changes.
  const changes = typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule);
  changes?.observe(doc.body, { childList: true, attributes: true, attributeFilter: ["class", "style"] });
  const statusChanges = typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule);
  const initial = doc.querySelector<HTMLElement>(".status-bar");
  if (initial) statusChanges?.observe(initial, { attributes: true, childList: true, subtree: true });
  win.addEventListener("resize", schedule);
  win.addEventListener("pointerup", schedule);
  refresh();
  return () => {
    disposed = true; if (frame) win.cancelAnimationFrame(frame);
    resize?.disconnect(); changes?.disconnect(); statusChanges?.disconnect();
    win.removeEventListener("resize", schedule); win.removeEventListener("pointerup", schedule);
    root.style.removeProperty("--mw-host-bottom");
  };
}
