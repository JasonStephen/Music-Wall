/** Reproduce changing global zoom while an Obsidian tab is hidden. */
export async function verifyHiddenZoom(root: HTMLElement, sync: (scale: number) => void): Promise<{checks: number; fail: string[]}> {
  let checks = 0; const fail: string[] = [];
  const expect = (ok: boolean, label: string) => { checks++; if (!ok) fail.push(label); };
  const wait = () => new Promise(resolve => setTimeout(resolve, 60));
  const previousZoom = document.body.style.getPropertyValue("--mw-zoom"), previousDisplay = root.style.display;
  const original = Number(root.dataset.mwZoom || 1);
  try {
    for (const scale of [.7, 1.5, 2, 1]) {
      root.style.display = "none"; await wait();
      expect(root.clientWidth === 0 && root.clientHeight === 0, "hidden tab has no measurable size");
      document.body.style.setProperty("--mw-zoom", String(scale)); sync(scale);
      expect(Number(root.dataset.mwZoom) === scale, "hidden tab remembers latest requested zoom");
      root.style.display = previousDisplay; await wait();
      const box = root.querySelector<HTMLElement>(":scope > .mw-zoombox")!, outer = root.getBoundingClientRect(), inner = box.getBoundingClientRect();
      expect(Math.abs(inner.width - outer.width) < 2 && Math.abs(inner.height - outer.height) < 2, "revealed tab fills pane without another zoom operation");
    }
  } finally { root.style.display = previousDisplay; document.body.style.setProperty("--mw-zoom", previousZoom); sync(original); await wait(); }
  return {checks, fail};
}
