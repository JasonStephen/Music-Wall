import type { HistoryStore, SearchScope } from "../core/history";
import { t } from "../i18n";
import { svgAction } from "./svgAction";

export function searchHistory(input: HTMLInputElement, form: HTMLElement, store: HistoryStore | undefined,
  scope: () => string, kind: SearchScope, submit: (keyword: string) => void): () => void {
  if (!store) return () => {};
  const panel = form.createDiv({ cls: "mw-search-history", attr: { "aria-label": t("history.search") } });
  panel.hidden = true;
  const draw = () => {
    panel.empty(); const values = store.searches(scope(), kind); panel.hidden = values.length === 0;
    if (!values.length) return;
    panel.createDiv({ cls: "mw-search-history__heading", text: t("history.search") });
    for (const keyword of values) {
      const row = panel.createDiv({ cls: "mw-search-history__row" });
      const pick = row.createEl("button", { cls: "mw-search-history__pick", text: keyword, attr: { type: "button", title: keyword } });
      pick.addEventListener("click", () => { input.value = keyword; panel.hidden = true; submit(keyword); });
      svgAction(row, "x", t("history.removeSearch", { name: keyword }), async () => {
        try { await store.remove(scope(), kind, keyword); if (panel.isConnected) { input.focus(); draw(); } } catch { /* Keep the search usable if storage is unavailable. */ }
      });
    }
  };
  input.addEventListener("focus", draw);
  input.addEventListener("keydown", event => { if (event.key === "Escape") { panel.hidden = true; event.stopPropagation(); } });
  form.addEventListener("focusout", () => setTimeout(() => { if (!form.contains(form.ownerDocument.activeElement)) panel.hidden = true; }, 0));
  form.addEventListener("submit", () => { panel.hidden = true; });
  return () => { panel.hidden = true; };
}
