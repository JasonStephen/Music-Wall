import { Notice } from "obsidian";
import { t } from "../i18n";

/** Handle one back action on release; suppress the associated native aux click. */
export function bindMouseBack(root: HTMLElement, back: () => unknown): () => void {
  let disposed = false, pending = false;
  const suppress = (event: MouseEvent) => { if (event.button === 3) { event.preventDefault(); event.stopPropagation(); } };
  const release = (event: MouseEvent) => {
    if (event.button !== 3 || disposed) return;
    suppress(event);
    if (pending) return;
    pending = true;
    void Promise.resolve().then(() => { if (!disposed) return back(); }).catch(() => new Notice(t("library.failed"))).finally(() => { pending = false; });
  };
  root.addEventListener("mousedown", suppress, true);
  root.addEventListener("mouseup", release, true);
  root.addEventListener("auxclick", suppress, true);
  return () => { disposed = true; root.removeEventListener("mousedown", suppress, true); root.removeEventListener("mouseup", release, true); root.removeEventListener("auxclick", suppress, true); };
}
