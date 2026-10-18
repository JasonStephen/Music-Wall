import { Notice, setIcon } from "obsidian";
import { t } from "../i18n";

/** Keep the SVG mounted while busy; fixed icon geometry survives tablet button styles. */
export function svgAction(parent: HTMLElement, icon: string, label: string, action: () => void | Promise<unknown>, text = false): HTMLButtonElement {
  const button = parent.createEl("button", { cls: "clickable-icon mw-svg-action", attr: { type: "button", title: label, "aria-label": label } });
  const glyph = button.createSpan({ cls: "mw-control-icon", attr: { "aria-hidden": "true" } });
  setIcon(glyph, icon);
  if (!glyph.querySelector("svg")) setIcon(glyph, "circle");
  if (text) button.createSpan({ text: label });
  button.addEventListener("click", () => {
    if (button.disabled) return;
    button.disabled = true; button.setAttr("aria-busy", "true");
    void Promise.resolve().then(action).catch(() => new Notice(t("library.failed"))).finally(() => { button.disabled = false; button.removeAttribute("aria-busy"); });
  });
  return button;
}
