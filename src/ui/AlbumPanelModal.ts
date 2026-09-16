// 共享「唱片详情面板」：左侧当前样式大预览（只读，样式跟随墙全局）+ 右侧 metadata。
// 播放确认（mode=play）与搜索添加确认（mode=add）复用同一组件，
// 底部按钮与回调按模式切换（计划书 §变更B.2）。

import { App, Modal } from "obsidian";
import type { AlbumMeta, DiscStyle, WallItem } from "../types";
import { buildDiscElement } from "./disc";
import { fmtDur, fmtTotalDur, fmtTotalDurTip, sumTrackDur } from "./duration";
import { playAlbum, type PlaybackDeps } from "../core/playback";

export interface PanelOptions {
  meta: AlbumMeta;
  style: DiscStyle;
  locked?: boolean;
  source?: "search" | "manual";
}

/** 渲染共享面板到容器 */
export function renderAlbumPanel(container: HTMLElement, opts: PanelOptions): void {
  container.empty();
  container.addClass("mw-panel");

  // 左：预览（样式跟随墙全局，无单卡切换）
  const left = container.createDiv({ cls: "mw-panel__left" });
  const preview = left.createDiv({ cls: "mw-panel__preview" });
  const item: WallItem = {
    albumId: opts.meta.albumId,
    source: opts.source ?? "manual",
    locked: !!opts.locked,
    meta: opts.meta,
    addedAt: "",
  };
  preview.appendChild(buildDiscElement(item, opts.style, { coverSize: 500 }));

  // 右：metadata
  const right = container.createDiv({ cls: "mw-panel__right" });
  right.createDiv({ cls: "mw-panel__title", text: opts.meta.name });
  right.createDiv({
    cls: "mw-panel__artist",
    text: opts.meta.artist || "未知艺术家",
  });

  const meta = right.createDiv({ cls: "mw-panel__meta" });
  const row = (k: string, v?: string | number) => {
    if (v === undefined || v === "" || v === null) return;
    const r = meta.createDiv({ cls: "mw-panel__row" });
    r.createSpan({ cls: "mw-panel__k", text: k });
    r.createSpan({ cls: "mw-panel__v", text: String(v) });
  };
  row("发行", opts.meta.year);
  row("曲目数", opts.meta.trackCount);
  // 总时长：档位化展示（分钟/小时），悬停给"总分钟:秒"
  const totalDur = sumTrackDur(opts.meta.tracks);
  if (totalDur > 0) {
    const r = meta.createDiv({ cls: "mw-panel__row" });
    r.createSpan({ cls: "mw-panel__k", text: "总时长" });
    r.createSpan({
      cls: "mw-panel__v mw-panel__v--dur",
      text: fmtTotalDur(totalDur),
      title: fmtTotalDurTip(totalDur),
    });
  }
  row("唱片公司", opts.meta.company);

  if (opts.meta.description) {
    const desc = right.createDiv({ cls: "mw-panel__desc" });
    desc.createDiv({ cls: "mw-panel__desc-title", text: "简介" });
    desc.createDiv({ cls: "mw-panel__desc-body", text: opts.meta.description });
  }

  if (opts.meta.tracks?.length) {
    const trackWrap = right.createDiv({ cls: "mw-panel__tracks" });
    trackWrap.createDiv({ cls: "mw-panel__tracks-title", text: "曲目" });
    const list = trackWrap.createEl("ol");
    list.addClass("mw-panel__track-list");
    for (const t of opts.meta.tracks) {
      const li = list.createEl("li");
      li.createSpan({ cls: "mw-track-name", text: t.name });
      const dur = t.duration ? fmtDur(t.duration) : "";
      if (dur) li.createSpan({ cls: "mw-track-dur", text: dur });
    }
  }
}

type PanelModalMode = "play" | "add";

export class AlbumPanelModal extends Modal {
  private mode: PanelModalMode;
  private meta: AlbumMeta;
  private style: DiscStyle;
  private locked: boolean;
  private source: "search" | "manual";
  private deps: PlaybackDeps;
  private onAdd?: () => void;

  constructor(
    app: App,
    mode: PanelModalMode,
    args: {
      meta: AlbumMeta;
      style: DiscStyle;
      locked?: boolean;
      source?: "search" | "manual";
      deps: PlaybackDeps;
      onAdd?: () => void;
    }
  ) {
    super(app);
    this.mode = mode;
    this.meta = args.meta;
    this.style = args.style;
    this.locked = !!args.locked;
    this.source = args.source ?? "manual";
    this.deps = args.deps;
    this.onAdd = args.onAdd;
  }

  onOpen(): void {
    // 弹窗跟随全局缩放（--mw-zoom 设在 body 上，这里只是挂上作用域类）
    this.modalEl.addClass("mw-modal-zoom");
    const { contentEl } = this;
    contentEl.addClass("mw-album-modal");
    contentEl.createEl("h2", {
      text: this.mode === "play" ? "播放确认" : "添加到音乐墙",
      cls: "mw-album-modal__heading",
    });

    const panel = contentEl.createDiv();
    renderAlbumPanel(panel, {
      meta: this.meta,
      style: this.style,
      locked: this.locked,
      source: this.source,
    });

    const btns = contentEl.createDiv({ cls: "mw-album-modal__buttons" });
    const cancel = btns.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());

    const primary = btns.createEl("button", {
      text: this.mode === "play" ? "▶ 播放" : "确认添加",
      cls: "mod-cta",
    });
    primary.addEventListener("click", async () => {
      if (this.mode === "play") {
        this.close();
        await playAlbum(this.meta, this.deps);
      } else {
        this.onAdd?.();
        this.close();
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
