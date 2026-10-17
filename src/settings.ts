// 插件设置页：Git 仓库、网易云扫码登录、默认样式、列宽。

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
import { hasLoginCookie } from "./core/playlist";

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
          this.display();
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
            this.display();
          }
        }));
    }
    const explanation = containerEl.createEl("details", { cls: "mw-auth-info" });
    explanation.createEl("summary", { text: t("auth.aboutTitle") });
    explanation.createEl("p", { text: t("auth.aboutService") });
    explanation.createEl("p", { text: t("auth.aboutStorage") });
    explanation.createEl("p", { text: t("auth.aboutPlayback") });
    explanation.createEl("p", { text: t("auth.aboutLogout") });
    const sources = explanation.createEl("p");
    sources.createEl("a", {
      text: "NeteaseCloudMusicApiEnhanced",
      attr: { href: "https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced", target: "_blank", rel: "noopener noreferrer" },
    });
    sources.appendText(" · ");
    sources.createEl("a", {
      text: "music-lib",
      attr: { href: "https://github.com/guohuiyuan/music-lib", target: "_blank", rel: "noopener noreferrer" },
    });

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
