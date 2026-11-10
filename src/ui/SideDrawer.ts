// 播放器样式面板的开合与键盘交互。
import { setIcon } from "obsidian";
import { t } from "../i18n";

export type DrawerKey = "settings";

export interface DrawerApi {
  /** 收起面板 */
  close(): void;
  /** 重建当前面板内容（改数据后刷新列表用，不关闭面板） */
  refresh(): void;
}

export type DrawerBuilder = (body: HTMLElement, api: DrawerApi) => void;

interface DrawerEntry {
  title: string;
  build: DrawerBuilder;
}

export class SideDrawer {
  private panel: HTMLElement;
  private titleEl: HTMLElement;
  private bodyEl: HTMLElement;
  private openKey: DrawerKey | null = null;
  private entries = new Map<DrawerKey, DrawerEntry>();
  private onAfterChange: (() => void) | undefined;
  private onKey: (e: KeyboardEvent) => void;
  private disposed = false;

  constructor(
    host: HTMLElement,
    onAfterChange?: () => void
  ) {
    this.onAfterChange = onAfterChange;

    // 刻意**不创建遮罩**（第四轮结论，别再改回去）：
    // 1) 上一轮把遮罩从「只盖网格区」扩到整块缩放盒后，它会盖住顶栏图标——
    //    用户点图标其实点在遮罩上，「展开侧栏 = 整屏变暗」也被明确否决；
    // 2) 遮罩一旦与实例状态不同步（close() 的守卫早退 / dispose() 不清类名），
    //    就会留下「看得见但点不动、还吞掉所有点击」的幽灵层。
    // 关闭途径：工具栏图标 / 面板右上 × / Esc。
    this.panel = host.createDiv({
      cls: "mw-drawer",
    });
    const head = this.panel.createDiv({ cls: "mw-drawer__head" });
    this.titleEl = head.createDiv({ cls: "mw-drawer__title" });
    const closeBtn = head.createEl("button", { cls: "clickable-icon mw-drawer__close" });
    closeBtn.setAttr("aria-label", t("common.closePanel"));
    closeBtn.setAttr("title", t("common.closeEsc"));
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", () => this.close());

    this.bodyEl = this.panel.createDiv({ cls: "mw-drawer__body" });

    // 捕获阶段：面板打开时优先处理 Esc
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

  /** 当前面板的 body 元素（外部聚焦/查询控件用） */
  currentBodyEl(): HTMLElement | null {
    return this.openKey ? this.bodyEl : null;
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
    this.onAfterChange?.();
  }

  /**
   * 收起面板。**无条件清理 DOM 类名**：状态为空时也要把 is-open 摘掉，
   * 否则「实例已 dispose / 状态已清空，但 DOM 还留着 is-open」会变成
   * 一个盖住视图、吞掉点击的幽灵面板（第三轮踩过）。
   */
  close(): void {
    const wasOpen = this.openKey !== null;
    this.openKey = null;
    this.panel.removeClass("is-open");
    this.bodyEl.empty();
    if (wasOpen) this.onAfterChange?.();
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

  /** 视图重建/卸载时调用：撤掉全局监听、清掉自身类名，避免旧实例残留 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    document.removeEventListener("keydown", this.onKey, true);
    this.openKey = null;
    this.panel.removeClass("is-open");
  }

  private renderBody(entry: DrawerEntry): void {
    this.bodyEl.empty();
    entry.build(this.bodyEl, {
      close: () => this.close(),
      refresh: () => this.refresh(),
    });
  }
}
