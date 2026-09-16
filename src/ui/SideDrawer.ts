// 右侧滑出抽屉：音乐墙与播放器页共用的图标面板外壳。
//
// 设计要点：
// - 挂在视图根节点下（absolute 覆盖层），因此不参与 .mw-grid 的滚动；
// - 内容由调用方通过 builder 提供，每次 open/refresh 重建，避免陈旧闭包；
// - Esc / 点遮罩 / 关闭钮三种收起方式；外部按钮的激活态由 onAfterChange 回调同步。

export type DrawerKey = "style" | "filter" | "group" | "sort" | "search" | "settings";

export interface DrawerApi {
  /** 收起抽屉 */
  close(): void;
  /** 重建当前面板内容（改数据后刷新列表用，不关闭抽屉） */
  refresh(): void;
}

export type DrawerBuilder = (body: HTMLElement, api: DrawerApi) => void;

interface DrawerEntry {
  title: string;
  build: DrawerBuilder;
}

export class SideDrawer {
  private host: HTMLElement;
  private scrim: HTMLElement;
  private panel: HTMLElement;
  private titleEl: HTMLElement;
  private bodyEl: HTMLElement;
  private openKey: DrawerKey | null = null;
  private entries = new Map<DrawerKey, DrawerEntry>();
  private onAfterChange: (() => void) | undefined;
  private onKey: (e: KeyboardEvent) => void;
  private disposed = false;

  constructor(host: HTMLElement, onAfterChange?: () => void) {
    this.host = host;
    this.onAfterChange = onAfterChange;

    this.scrim = host.createDiv({ cls: "mw-drawer__scrim" });
    this.scrim.addEventListener("click", () => this.close());

    this.panel = host.createDiv({ cls: "mw-drawer" });
    const head = this.panel.createDiv({ cls: "mw-drawer__head" });
    this.titleEl = head.createDiv({ cls: "mw-drawer__title" });
    const closeBtn = head.createEl("button", { cls: "mw-drawer__close" });
    closeBtn.setAttr("aria-label", "关闭面板");
    closeBtn.setAttr("title", "关闭 (Esc)");
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => this.close());

    this.bodyEl = this.panel.createDiv({ cls: "mw-drawer__body" });

    // 捕获阶段：抽屉打开时优先吃掉 Esc，不让它继续去关展示架详情
    this.onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !this.openKey) return;
      e.stopPropagation();
      this.close();
    };
    document.addEventListener("keydown", this.onKey, true);
  }

  /** 注册一个面板（key 相同则覆盖） */
  register(key: DrawerKey, title: string, build: DrawerBuilder): void {
    this.entries.set(key, { title, build });
  }

  isOpen(): boolean {
    return this.openKey !== null;
  }

  currentKey(): DrawerKey | null {
    return this.openKey;
  }

  /** 打开面板；再次调用同一个 key 视为收起（图标钮的开关语义） */
  toggle(key: DrawerKey): void {
    if (this.openKey === key) this.close();
    else this.open(key);
  }

  open(key: DrawerKey): void {
    if (this.disposed) return;
    const entry = this.entries.get(key);
    if (!entry) return;
    this.openKey = key;
    this.titleEl.textContent = entry.title;
    this.renderBody(entry);
    this.panel.addClass("is-open");
    this.scrim.addClass("is-open");
    this.onAfterChange?.();
  }

  close(): void {
    if (!this.openKey) return;
    this.openKey = null;
    this.panel.removeClass("is-open");
    this.scrim.removeClass("is-open");
    this.bodyEl.empty();
    this.onAfterChange?.();
  }

  /** 重建当前面板（数据变更后刷新内容，不改变开合状态） */
  refresh(): void {
    const key = this.openKey;
    if (!key) return;
    const entry = this.entries.get(key);
    if (!entry) return;
    this.titleEl.textContent = entry.title;
    this.renderBody(entry);
  }

  /** 视图重建/卸载时调用：撤掉全局监听，避免旧实例残留 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    document.removeEventListener("keydown", this.onKey, true);
    this.openKey = null;
  }

  private renderBody(entry: DrawerEntry): void {
    this.bodyEl.empty();
    entry.build(this.bodyEl, {
      close: () => this.close(),
      refresh: () => this.refresh(),
    });
  }
}
