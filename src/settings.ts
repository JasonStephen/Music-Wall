// 插件设置页：Git 仓库、网易云 Cookie、默认样式、列宽。

import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type MusicWallPlugin from "./main";
import {
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  clampZoom,
  type DiscStyle,
  type PlayerBackground,
  type ShelfCaption,
} from "./types";
import {
  playerBgLabel,
  shelfCaptionLabel,
  styleLabel,
  t,
  type LanguagePref,
} from "./i18n";
import { ALL_STYLES } from "./ui/disc";

export class MusicWallSettingTab extends PluginSettingTab {
  private plugin: MusicWallPlugin;

  constructor(app: App, plugin: MusicWallPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

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

    new Setting(containerEl)
      .setName(t("settings.cookie.name"))
      .setDesc(t("settings.cookie.desc"))
      .addTextArea((te) => {
        te.setPlaceholder("__remember_uid=...; MUSIC_U=...;")
          .setValue(this.plugin.settings.neteaseCookie)
          .onChange(async (v) => {
            this.plugin.settings.neteaseCookie = v.trim();
            await this.plugin.saveSettings();
          });
        te.inputEl.rows = 3;
      })
      .addButton((b) =>
        b
          .setButtonText(t("settings.cookie.verify"))
          .setTooltip(t("settings.cookie.verifyTip"))
          .onClick(async () => {
            b.setDisabled(true);
            try {
              await this.plugin.verifyCookieNow();
            } catch (e: any) {
              new Notice(
                t("settings.cookie.invalid", { error: e?.message ?? e })
              );
            } finally {
              b.setDisabled(false);
            }
          })
      );

    new Setting(containerEl)
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
          .onClick(() => {
            void this.plugin.pickPlaybackPlaylist();
            this.display();
          })
      );

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

    new Setting(containerEl)
      .setName(t("settings.colWidth.name"))
      .setDesc(t("settings.colWidth.desc"))
      .addSlider((s) =>
        s
          .setLimits(140, 320, 10)
          .setValue(this.plugin.settings.minColumnWidth)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.minColumnWidth = v;
            await this.plugin.saveSettings();
            this.plugin.refreshOpenViews();
          })
      );

    const BG_KEYS: PlayerBackground[] = ["white", "dark", "art", "wood"];
    new Setting(containerEl)
      .setName(t("settings.playerBg.name"))
      .setDesc(t("settings.playerBg.desc"))
      .addDropdown((d) => {
        for (const v of BG_KEYS) d.addOption(v, playerBgLabel(v));
        d.setValue(this.plugin.settings.playerBackground).onChange(async (v) => {
          this.plugin.settings.playerBackground = v as PlayerBackground;
          await this.plugin.saveSettings();
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
}
