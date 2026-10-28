import { Notice, Setting } from "obsidian";
import type MusicWallPlugin from "../main";
import { t } from "../i18n";
import { DEFAULT_ARTIST_ALBUM_KEYWORDS, normalizeArtistAlbumFilters } from "../core/artistAlbumFilters";

export function renderArtistAlbumSettings(container: HTMLElement, plugin: MusicWallPlugin, onApplied?: () => void): void {
  const draft = normalizeArtistAlbumFilters(plugin.settings);
  const form = container.createDiv({ cls: "mw-artist-filters__form" });
  let limitText = String(draft.artistAlbumTrackLimit);
  const render = () => {
    form.empty();
    new Setting(form).setName(t("artistAlbumFilters.singles")).setDesc(t("artistAlbumFilters.singlesDesc"))
      .addToggle(toggle => toggle.setValue(draft.artistAlbumHideSingles).onChange(value => { draft.artistAlbumHideSingles = value; }));
    new Setting(form).setName(t("artistAlbumFilters.limit")).setDesc(t("artistAlbumFilters.limitDesc"))
      .addText(text => {
        text.inputEl.type = "number"; text.inputEl.min = "0"; text.inputEl.step = "1";
        text.setValue(limitText).onChange(value => { limitText = value; });
      });
    new Setting(form).setName(t("artistAlbumFilters.remixes")).setDesc(t("artistAlbumFilters.remixesDesc"))
      .addToggle(toggle => toggle.setValue(draft.artistAlbumHideRemixes).onChange(value => { draft.artistAlbumHideRemixes = value; }));
    new Setting(form).setName(t("artistAlbumFilters.keywords"))
      .addTextArea(text => text.setValue(draft.artistAlbumKeywords).onChange(value => { draft.artistAlbumKeywords = value; }))
      .settingEl.addClass("mw-artist-filters__keywords");
    new Setting(form)
      .addButton(button => button.setButtonText(t("artistAlbumFilters.reset")).onClick(() => {
        limitText = "1"; draft.artistAlbumKeywords = DEFAULT_ARTIST_ALBUM_KEYWORDS;
        render();
      }))
      .addButton(button => button.setButtonText(t("artistAlbumFilters.apply")).setCta().onClick(async () => {
        const limit = Number(limitText);
        if (!limitText.trim() || !Number.isSafeInteger(limit) || limit < 0) { new Notice(t("artistAlbumFilters.invalidLimit")); return; }
        const next = { ...draft, artistAlbumTrackLimit: limit };
        button.setDisabled(true);
        try {
          await plugin.saveData({ ...plugin.settings, ...next });
          Object.assign(plugin.settings, next);
          plugin.refreshOpenViews(); onApplied?.();
        } catch { new Notice(t("library.failed")); }
        finally { button.setDisabled(false); }
      }));
  };
  render();
}

export function showArtistAlbumMenu(plugin: MusicWallPlugin, anchor: HTMLElement): { hide: () => void } {
  const doc = anchor.ownerDocument, win = doc.defaultView!;
  const popup = doc.body.createDiv({ cls: "mw-artist-filters" });
  popup.setAttr("role", "dialog"); popup.setAttr("aria-label", t("artistAlbumFilters.title"));
  anchor.setAttr("aria-expanded", "true");
  let hidden = false;
  const hide = (restoreFocus = false) => {
    if (hidden) return; hidden = true;
    doc.removeEventListener("pointerdown", outside, true); doc.removeEventListener("keydown", keydown, true);
    doc.removeEventListener("focusin", focus); doc.removeEventListener("scroll", scroll, true); win.removeEventListener("resize", reposition);
    popup.remove(); anchor.setAttr("aria-expanded", "false");
    if (restoreFocus && anchor.isConnected) anchor.focus();
  };
  const outside = (event: PointerEvent) => { if (!popup.contains(event.target as Node) && !anchor.contains(event.target as Node)) hide(); };
  const focus = (event: FocusEvent) => { if (!popup.contains(event.target as Node) && !anchor.contains(event.target as Node)) hide(); };
  const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); hide(true); } };
  const reposition = () => {
    const rect = anchor.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(rect.right - popup.offsetWidth, win.innerWidth - popup.offsetWidth - 8))}px`;
    const below = win.innerHeight - rect.bottom - 12, above = rect.top - 12;
    const down = below >= Math.min(popup.scrollHeight, 420) || below >= above;
    popup.style.maxHeight = `${Math.max(80, down ? below : above)}px`;
    popup.style.top = `${down ? rect.bottom + 4 : Math.max(8, rect.top - popup.offsetHeight - 4)}px`;
  };
  const scroll = (event: Event) => { if (!popup.contains(event.target as Node)) hide(); };
  popup.createEl("h4", { text: t("artistAlbumFilters.title") });
  renderArtistAlbumSettings(popup, plugin, () => hide(true));
  doc.addEventListener("pointerdown", outside, true); doc.addEventListener("keydown", keydown, true);
  doc.addEventListener("focusin", focus); doc.addEventListener("scroll", scroll, true); win.addEventListener("resize", reposition);
  reposition(); popup.querySelector<HTMLElement>("input, button")?.focus();
  return { hide: () => hide() };
}
