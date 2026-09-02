// 插件设置页：Git 仓库、网易云 Cookie、默认样式、列宽。

import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type MusicWallPlugin from "./main";
import type { DiscStyle, ShelfCaption } from "./types";
import { STYLE_LABELS } from "./ui/disc";

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
      .setName("Git 远程仓库地址")
      .setDesc("填入存放 .mw 音乐墙文件的仓库 URL（https），用于「Git 导入」（仅桌面端）")
      .addText((t) =>
        t
          .setPlaceholder("https://github.com/user/music-walls.git")
          .setValue(this.plugin.settings.gitRepoUrl)
          .onChange(async (v) => {
            this.plugin.settings.gitRepoUrl = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Git 分支")
      .setDesc("留空则使用仓库默认分支")
      .addText((t) =>
        t
          .setPlaceholder("main")
          .setValue(this.plugin.settings.gitBranch)
          .onChange(async (v) => {
            this.plugin.settings.gitBranch = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Git 子目录")
      .setDesc("仅扫描该子目录下的 .mw 文件；留空扫描整个仓库")
      .addText((t) =>
        t
          .setPlaceholder("walls")
          .setValue(this.plugin.settings.gitSubdir)
          .onChange(async (v) => {
            this.plugin.settings.gitSubdir = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("网易云 Cookie（可选）")
      .setDesc(
        "登录后的完整 Cookie（必须包含 MUSIC_U）才能整专连播；留空亦可浏览/搜索。注意：仅存于本机"
      )
      .addTextArea((t) => {
        t.setPlaceholder("__remember_uid=...; MUSIC_U=...;")
          .setValue(this.plugin.settings.neteaseCookie)
          .onChange(async (v) => {
            this.plugin.settings.neteaseCookie = v.trim();
            await this.plugin.saveSettings();
          });
        t.inputEl.rows = 3;
      })
      .addButton((b) =>
        b
          .setButtonText("验证")
          .setTooltip("检查 Cookie 登录态并显示账号昵称")
          .onClick(async () => {
            b.setDisabled(true);
            try {
              await this.plugin.verifyCookieNow();
            } catch (e: any) {
              new Notice("Cookie 无效：" + (e?.message ?? e));
            } finally {
              b.setDisabled(false);
            }
          })
      );

    new Setting(containerEl)
      .setName("播放歌单 ID")
      .setDesc(
        "配合上方 Cookie 实现整张专辑连播：播放时把专辑曲目写入该歌单并让客户端切到该歌单播放。留空且 Cookie 有效时会自动创建/复用私密中转歌单「Music Wall 临时播放」。可点右侧按钮从账号歌单中选择"
      )
      .addText((t) =>
        t
          .setPlaceholder("如 123456789")
          .setValue(this.plugin.settings.playbackPlaylistId)
          .onChange(async (v) => {
            this.plugin.settings.playbackPlaylistId = v.trim();
            await this.plugin.saveSettings();
          })
      )
      .addButton((b) =>
        b
          .setButtonText("从账号选择")
          .setTooltip("需已配置 Cookie")
          .onClick(() => {
            void this.plugin.pickPlaybackPlaylist();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("新建墙的默认样式")
      .addDropdown((d) => {
        for (const [v, label] of Object.entries(STYLE_LABELS)) {
          d.addOption(v, label);
        }
        d.setValue(this.plugin.settings.defaultStyle).onChange(async (v) => {
          this.plugin.settings.defaultStyle = v as DiscStyle;
          await this.plugin.saveSettings();
        });
      });

    const CAPTION_LABELS: Record<ShelfCaption, string> = {
      hidden: "隐藏",
      pull: "抽出时显示",
      always: "常驻显示",
    };
    new Setting(containerEl)
      .setName("展示架文字显示")
      .setDesc("仅「展示架」布局生效：专辑名/艺术家的显示档位")
      .addDropdown((d) => {
        for (const [v, label] of Object.entries(CAPTION_LABELS)) {
          d.addOption(v, label);
        }
        d.setValue(this.plugin.settings.shelfCaption).onChange(async (v) => {
          this.plugin.settings.shelfCaption = v as ShelfCaption;
          await this.plugin.saveSettings();
          this.plugin.refreshOpenViews();
        });
      });

    new Setting(containerEl)
      .setName("唱片最小列宽 (px)")
      .setDesc("越小一屏容纳越多；影响网格 auto-fill 列数")
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
  }
}
