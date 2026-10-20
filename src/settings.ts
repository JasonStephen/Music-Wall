// 分类设置页：常规、音乐墙、播放器、账号和 Git 同步。

import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type MusicWallPlugin from "./main";
import { AUDIO_QUALITIES, isAudioQuality, qualityLabel } from "./core/quality";
import {
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  clampZoom,
  type DiscStyle,
  type ShelfCaption,
} from "./types";
import {
  shelfCaptionLabel,
  styleLabel,
  t,
  type LanguagePref,
} from "./i18n";
import { ALL_STYLES } from "./ui/disc";
import { ConfirmModal } from "./ui/ConfirmModal";
import { coverToneCacheCount, coverToneCacheUsage } from "./ui/accent";
import { hasLoginCookie } from "./core/playlist";

export class MusicWallSettingTab extends PluginSettingTab {
  private plugin: MusicWallPlugin;
  private usageTimer: ReturnType<typeof setInterval> | null = null;
  private displayGeneration = 0;
  private activeTab: SettingsCategory = "general";
  private scrollPositions: Partial<Record<SettingsCategory, number>> = {};
  hide(): void { ++this.displayGeneration; if (this.usageTimer) clearInterval(this.usageTimer); this.usageTimer = null; }

  constructor(app: App, plugin: MusicWallPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    this.hide(); const generation = this.displayGeneration;
    const { containerEl } = this;
    containerEl.empty();

    containerEl.addClass("mw-settings");
    const tabs = containerEl.createDiv({ cls: "mw-settings__tabs", attr: { role: "tablist", "aria-label": t("settingsCategories.title") } });
    const panel = containerEl.createDiv({ cls: "mw-settings__panel", attr: { role: "tabpanel", id: "mw-settings-panel", "aria-labelledby": `mw-settings-tab-${this.activeTab}` } });
    const keys = ["general", "wall", "player", "cache", "account", "sync"] as const;
    for (const key of keys) {
      const selected = key === this.activeTab;
      const button = tabs.createEl("button", { cls: "mw-settings__tab", attr: { type: "button", role: "tab", id: `mw-settings-tab-${key}`, "aria-controls": "mw-settings-panel", "aria-selected": String(selected), tabindex: selected ? "0" : "-1" } });
      settingsIcon(button, key);
      button.createSpan({ text: t(`settingsCategories.${key}`) });
      button.addEventListener("click", () => this.selectTab(key));
      button.addEventListener("keydown", event => {
        const index = keys.indexOf(key);
        const next = event.key === "ArrowRight" ? keys[(index + 1) % keys.length] : event.key === "ArrowLeft" ? keys[(index + keys.length - 1) % keys.length] : event.key === "Home" ? keys[0] : event.key === "End" ? keys[keys.length - 1] : null;
        if (!next) return;
        event.preventDefault(); this.selectTab(next);
        this.containerEl.querySelector<HTMLButtonElement>(`#mw-settings-tab-${next}`)?.focus();
      });
    }
    this.renderCategory(panel, generation);
    containerEl.scrollTop = this.scrollPositions[this.activeTab] || 0;
  }

  private renderCacheManagement(container: HTMLElement, generation: number): void {
    const format = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
    const run = async (kind: "audio" | "lyrics" | "stats" | "cover" | "playback" | "search" | "all") => {
      try {
        if (kind === "audio") await this.plugin.audioTransport?.clear();
        else await this.plugin.clearManagedCache(kind);
        new Notice(t("cacheManager.done")); this.display();
      } catch { new Notice(t("cacheManager.failed")); }
    };
    const summary = new Setting(container).setName(t("cacheManager.total")).setDesc("—").addButton(button => button.setButtonText(t("cacheManager.all")).onClick(() => {
      new ConfirmModal(this.app, {title:t("cacheManager.all"),message:t("cacheManager.confirm"),details:[t("cacheManager.warning")],danger:true,confirmText:t("cacheManager.all"),onConfirm:()=>{ void run("all"); }}).open();
    }));
    summary.settingEl.addClass("mw-cache-summary");
    const rows = new Map<string, Setting>();
    for (const kind of ["audio", "lyrics", "stats", "cover", "playback", "search"] as const) {
      const row = new Setting(container).setName(t(`cacheManager.${kind}`)).setDesc("—").addButton(button => {
        const el = button.buttonEl;
        el.setAttribute("aria-label", `${t("cacheManager.clear")} · ${t(`cacheManager.${kind}`)}`);
        button.setTooltip(kind === "cover" ? t("cacheManager.coverDesc", {count: coverToneCacheCount()}) : t("cacheManager.clear"));
        el.addClass("mw-cache-trash");
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "18"); svg.setAttribute("height", "18"); svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "1.8"); svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round"); svg.setAttribute("aria-hidden", "true");
        const path = document.createElementNS(svg.namespaceURI, "path"); path.setAttribute("d", "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"); svg.appendChild(path); el.appendChild(svg);
        button.setDisabled(kind === "audio" && !this.plugin.audioTransport?.supported).onClick(async () => {
          if (kind === "playback" || kind === "search") new ConfirmModal(this.app, {title:t(`cacheManager.${kind}`),message:t("cacheManager.historyDesc"),danger:true,onConfirm:()=>{ void run(kind); }}).open();
          else { button.setDisabled(true); await run(kind); if (generation === this.displayGeneration) button.setDisabled(false); }
        });
      });
      row.settingEl.addClass("mw-cache-item"); rows.set(kind, row);
    }
    const update = async () => {
      const audio = this.plugin.audioTransport?.supported ? await this.plugin.audioTransport.usage() : 0;
      if (generation !== this.displayGeneration) return;
      const sizes = {audio, lyrics:this.plugin.lyrics?.usage() || 0, stats:this.plugin.collectionStatsCache?.usage() || 0, cover:coverToneCacheUsage(), playback:this.plugin.historyStore?.usage("playback") || 0, search:this.plugin.historyStore?.usage("search") || 0};
      summary.setDesc(format(Object.values(sizes).reduce((a,b)=>a+b,0)));
      for (const [kind, size] of Object.entries(sizes)) rows.get(kind)?.setDesc(kind === "audio" ? format(size) : t("cacheManager.estimated", {size:format(size)}));
    };
    void update().catch(() => {});
    this.usageTimer = setInterval(() => { void update().catch(() => {}); }, 2000);
  }

  private selectTab(key: SettingsCategory): void {
    if (key === this.activeTab) return;
    this.scrollPositions[this.activeTab] = this.containerEl.scrollTop;
    this.activeTab = key; this.display();
  }

  private renderCategory(containerEl: HTMLElement, generation: number): void {
    if (this.activeTab === "general") {

      new Setting(containerEl)
        .setName(t("settings.lang.name"))
        .setDesc(t("settings.lang.desc"))
        .addDropdown((d) => {
          const opts: Record<LanguagePref, string> = {
            system: t("settings.lang.system"),
            "zh-CN": "简体中文",
            "zh-TW": "繁體中文",
            en: "English",
          };
          for (const [v, label] of Object.entries(opts)) d.addOption(v, label);
          d.setValue(this.plugin.settings.language ?? "system").onChange(
            async (v) => {
              this.plugin.settings.language = v as LanguagePref;
              await this.plugin.saveSettings();
              // saveSettings 已应用语言并刷新视图；重绘设置页自身
              this.display();
            }
          );
        });

      new Setting(containerEl).setName(t("wallAppearance.title")).addDropdown(dropdown => {
        for (const mode of ["system", "light", "dark"] as const) dropdown.addOption(mode, t(`libraryAppearance.${mode}`));
        dropdown.setValue(this.plugin.settings.wallAppearance || "system").onChange(async mode => {
          this.plugin.settings.wallAppearance = mode as "system" | "light" | "dark";
          this.plugin.refreshWallAppearance(); await this.plugin.saveData(this.plugin.settings);
        });
      });

      new Setting(containerEl)
        .setName(t("settings.zoom.name"))
        .setDesc(t("settings.zoom.desc"))
        .addSlider((s) =>
          s
            .setLimits(ZOOM_MIN * 100, ZOOM_MAX * 100, ZOOM_STEP * 100)
            .setValue(Math.round((this.plugin.settings.zoomScale ?? 1) * 100))
            .setDynamicTooltip()
            .onChange(async (v) => {
              this.plugin.settings.zoomScale = clampZoom(v / 100);
              // 不重建视图：变量在 body 上，两个视图会立刻跟着变
              this.plugin.applyZoom();
              await this.plugin.saveData(this.plugin.settings);
            })
        );

    }
    if (this.activeTab === "wall") {
      new Setting(containerEl)
        .setName(t("settings.defaultStyle.name"))
        .addDropdown((d) => {
          for (const v of ALL_STYLES) {
            d.addOption(v, styleLabel(v));
          }
          d.setValue(this.plugin.settings.defaultStyle).onChange(async (v) => {
            this.plugin.settings.defaultStyle = v as DiscStyle;
            await this.plugin.saveSettings();
          });
        });

      const CAPTION_KEYS: ShelfCaption[] = ["hidden", "pull", "always"];
      new Setting(containerEl)
        .setName(t("settings.shelfCaption.name"))
        .setDesc(t("settings.shelfCaption.desc"))
        .addDropdown((d) => {
          for (const v of CAPTION_KEYS) {
            d.addOption(v, shelfCaptionLabel(v));
          }
          d.setValue(this.plugin.settings.shelfCaption).onChange(async (v) => {
            this.plugin.settings.shelfCaption = v as ShelfCaption;
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
          });
        });



    }
    if (this.activeTab === "player") {
      containerEl.createEl("h3", { text: t("settingsCategories.playback") });
      new Setting(containerEl)
        .setName(t("internal.modeName"))
        .setDesc(t("internal.modeDesc"))
        .addDropdown((dropdown) => dropdown
          .addOption("internal", t("internal.label"))
          .addOption("client", t("internal.client"))
          .setValue(this.plugin.settings.playbackMode ?? "internal")
          .onChange(async (value) => {
            await this.plugin.setPlaybackMode(value === "client" ? "client" : "internal");
            this.display();
          }));

      if (this.plugin.settings.playbackMode === "client") new Setting(containerEl)
        .setName(t("settings.playlist.name"))
        .setDesc(t("settings.playlist.desc"))
        .addText((te) =>
          te
            .setPlaceholder(t("settings.playlist.ph"))
            .setValue(this.plugin.settings.playbackPlaylistId)
            .onChange(async (v) => {
              this.plugin.settings.playbackPlaylistId = v.trim();
              await this.plugin.saveSettings();
            })
        )
        .addButton((b) =>
          b
            .setButtonText(t("settings.playlist.pick"))
            .setTooltip(t("settings.playlist.pickTip"))
            .onClick(async () => {
              await this.plugin.pickPlaybackPlaylist();
              this.display();
            })
        );

      new Setting(containerEl)
        .setName(t("quality.name"))
        .setDesc(t("quality.desc"))
        .addDropdown((dropdown) => {
          for (const quality of AUDIO_QUALITIES) dropdown.addOption(quality, qualityLabel(quality));
          dropdown.setValue(this.plugin.settings.defaultAudioQuality ?? "standard").onChange(async (value) => {
            if (!isAudioQuality(value)) return;
            this.plugin.settings.defaultAudioQuality = value;
            await this.plugin.saveSettings();
          });
        });

      for (const [field, name] of [["pauseFadeSeconds", "buffering.pauseFade"], ["crossFadeSeconds", "buffering.crossFade"]] as const) {
        const fade = new Setting(containerEl).setName(t(name)).addSlider(slider => slider
          .setLimits(0, 6, 0.1).setValue(this.plugin.settings[field]).setDynamicTooltip()
          .onChange(async value => { this.plugin.settings[field] = value; await this.plugin.saveData(this.plugin.settings); }));
        fade.settingEl?.addClass("mw-audio-setting");

    }
    containerEl.createEl("h3", { text: t("settingsCategories.appearance") });
    new Setting(containerEl)
      .setName(t("settings.smtc.name"))
      .setDesc(t("settings.smtc.desc"))
      .addToggle((te) =>
        te.setValue(this.plugin.settings.smtcEnabled).onChange(async (v) => {
          this.plugin.settings.smtcEnabled = v;
          await this.plugin.saveSettings();
          this.plugin.refreshOpenViews();
        })
      );
    }

    if (this.activeTab === "cache") {
    if (this.plugin.audioTransport?.supported) {
      containerEl.createEl("h3", { text: t("cacheManager.audio") });
      let updateUsage = async () => {};
      const capacity = new Setting(containerEl).setName(t("buffering.cacheLimit")).addText(input => {
        input.inputEl.type = "number"; input.inputEl.min = "0"; input.inputEl.max = "65536"; input.inputEl.step = "128";
        input.setValue(String(this.plugin.settings.audioCacheMB)).onChange(async value => {
          const size = Number(value); if (!value.trim() || !Number.isFinite(size) || size < 0 || size > 65536) return;
          this.plugin.settings.audioCacheMB = Math.round(size); await this.plugin.saveData(this.plugin.settings); await this.plugin.audioTransport?.trim(); await updateUsage();
        });
      });
      capacity.settingEl?.addClass("mw-audio-setting");
      updateUsage = async () => { if (generation === this.displayGeneration) this.display(); };
    }
      this.renderCacheManagement(containerEl, generation);
    }
    if (this.activeTab === "account") {
      const hasLogin = hasLoginCookie(this.plugin.settings.neteaseCookie);
      const account = new Setting(containerEl)
        .setName(t("auth.account"))
        .setDesc(hasLogin
          ? this.plugin.settings.neteaseNickname
            ? t("auth.savedAccount", { name: this.plugin.settings.neteaseNickname })
            : t("auth.savedCredential")
          : t("auth.signedOutDesc"));
      account.addButton((b) => b
        .setButtonText(t(hasLogin ? "auth.verify" : "auth.signIn"))
        .onClick(async () => {
          b.setDisabled(true);
          try {
            if (hasLogin) await this.plugin.verifyCookieNow();
            else await this.plugin.loginNetease();
          } catch {
            new Notice(t("auth.verifyFailed"));
          } finally {
            if (generation === this.displayGeneration) this.display();
          }
        }));
      if (this.plugin.settings.neteaseCookie) {
        account.addButton((b) => b
          .setButtonText(t("auth.signOut"))
          .onClick(async () => {
            b.setDisabled(true);
            try {
              await this.plugin.logoutNetease();
            } catch {
              new Notice(t("auth.saveFailed"));
            } finally {
              if (generation === this.displayGeneration) this.display();
            }
          }));

    }
    const explanation = containerEl.createEl("details", { cls: "mw-auth-info" });
    explanation.createEl("summary", { text: t("auth.aboutTitle") });
    explanation.createEl("p", { text: t("auth.aboutStorage") });
    explanation.createEl("p", { text: t("auth.aboutPlayback") });
    explanation.createEl("p", { text: t("auth.aboutLogout") });


    }
    if (this.activeTab === "sync") {
      containerEl.createDiv({ cls: "mw-git-experimental-warning", text: t("gitSyncExperimental.warning"), attr: { role: "note" } });
      new Setting(containerEl).setName(t("gitSyncExperimental.showActions")).setDesc(t("gitSyncExperimental.showActionsDesc")).addToggle(toggle => toggle.setValue(!!this.plugin.settings.showGitSyncActions).onChange(async enabled => {
        this.plugin.settings.showGitSyncActions = enabled; await this.plugin.saveSettings();
      }));
      const github = new Setting(containerEl).setName(t("githubAuth.title"))
        .setDesc(!Platform.isDesktopApp ? t("githubPull.hint") : this.plugin.settings.githubAccount ? t("githubAuth.current", { name: this.plugin.settings.githubAccount }) : t("githubAuth.system"))
        .addButton(button => button.setButtonText(t("githubAuth.manage")).setDisabled(!Platform.isDesktopApp).onClick(async () => {
          button.setDisabled(true);
          try { await this.plugin.loginGitHub(); if (generation === this.displayGeneration) this.display(); }
          finally { button.setDisabled(false); }
        }));
      github.settingEl.addClass("mw-git-sync-setting");

      new Setting(containerEl)
        .setName(t("settings.gitUrl.name"))
        .setDesc(t("settings.gitUrl.desc"))
        .addText((te) =>
          te
            .setPlaceholder("https://github.com/user/music-walls.git")
            .setValue(this.plugin.settings.gitRepoUrl)
            .onChange(async (v) => {
              this.plugin.settings.gitRepoUrl = v.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName(t("settings.gitBranch.name"))
        .setDesc(t("settings.gitBranch.desc"))
        .addText((te) =>
          te
            .setPlaceholder("main")
            .setValue(this.plugin.settings.gitBranch)
            .onChange(async (v) => {
              this.plugin.settings.gitBranch = v.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName(t("settings.gitSubdir.name"))
        .setDesc(t("settings.gitSubdir.desc"))
        .addText((te) =>
          te
            .setPlaceholder("walls")
            .setValue(this.plugin.settings.gitSubdir)
            .onChange(async (v) => {
              this.plugin.settings.gitSubdir = v.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl).setName(t("gitSync.localDirectory")).setDesc(t("gitSync.localDirectoryDesc"))
        .addText(input => input.setPlaceholder(t("gitSync.vaultRoot")).setValue(this.plugin.settings.gitLocalDir ?? "")
          .onChange(async value => { this.plugin.settings.gitLocalDir = value.trim(); await this.plugin.saveData(this.plugin.settings); }));
      const gitSync = new Setting(containerEl).setName(t("gitSync.title")).setDesc(t("gitSync.scope") + (!Platform.isDesktopApp ? ` ${t("githubPull.hint")}` : ""))
        .addButton(button => button.setButtonText(t("gitSync.pushCommand")).setDisabled(!Platform.isDesktopApp).onClick(() => void this.plugin.gitSync("push")))
        .addButton(button => button.setButtonText(t("gitSync.pullCommand")).onClick(() => void this.plugin.gitSync("pull")));
      gitSync.settingEl.addClass("mw-git-sync-setting");

    }
  }
}

type SettingsCategory = "general" | "wall" | "player" | "cache" | "account" | "sync";
const SETTINGS_ICONS: Record<SettingsCategory, string[]> = {
  general: ["M4 6h16M4 12h16M4 18h16", "M8 3v6M16 9v6M10 15v6"],
  wall: ["M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z", "M6 6h1M17 6h1M6 17h1M17 17h1"],
  player: ["M9 5v14l11-7z", "M3 8v8"],
  account: ["M15.5 7a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0", "M4 21v-2a8 8 0 0 1 16 0v2"],
  cache: ["M4 6c0-4 16-4 16 0s-16 4-16 0", "M4 6v12c0 4 16 4 16 0V6M4 12c0 4 16 4 16 0"],
  sync: ["M20 9a8 8 0 0 0-14-4L3 8m0-5v5h5", "M4 15a8 8 0 0 0 14 4l3-3m0 5v-5h-5"],
};
function settingsIcon(host: HTMLElement, category: SettingsCategory): void {
  const ns = "http://www.w3.org/2000/svg";
  const svg = host.ownerDocument.createElementNS(ns, "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(key, value);
  for (const d of SETTINGS_ICONS[category]) { const path = host.ownerDocument.createElementNS(ns, "path"); path.setAttribute("d", d); svg.appendChild(path); }
  host.appendChild(svg);
}
