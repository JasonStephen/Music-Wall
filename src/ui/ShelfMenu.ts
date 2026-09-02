// 自绘展示架风格右键菜单：深棕木纹面板，仅展示架卡片使用。
// Obsidian 原生 Menu 无法按实例换肤，这里用纯 DOM 实现；
// 菜单项与 openCardMenu 的原生菜单保持一致语义。

export interface ShelfMenuItem {
  title: string;
  danger?: boolean;
  onClick: () => void;
}

let activeCleanup: (() => void) | null = null;

function closeActive(): void {
  activeCleanup?.();
  activeCleanup = null;
}

/** 在 (x, y) 处弹出展示架风格菜单；点击外部/Esc/滚动关闭 */
export function openShelfMenu(x: number, y: number, items: ShelfMenuItem[]): void {
  closeActive();

  const doc = document;
  const menu = doc.createElement("div");
  menu.className = "mw-shelf-menu";

  for (const item of items) {
    const row = doc.createElement("div");
    row.className = item.danger ? "mw-shelf-menu__item is-danger" : "mw-shelf-menu__item";
    row.textContent = item.title;
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      closeActive();
      item.onClick();
    });
    menu.appendChild(row);
  }

  doc.body.appendChild(menu);

  // 视口内 clamp（先挂载拿到尺寸再定位）
  const rect = menu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - rect.width - 8);
  const py = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, px)}px`;
  menu.style.top = `${Math.max(8, py)}px`;

  const onOutside = (e: Event) => {
    if (!menu.contains(e.target as Node)) closeActive();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeActive();
  };
  const onScroll = () => closeActive();
  const onScrollCap = (e: Event) => {
    if (!menu.contains(e.target as Node)) closeActive();
  };

  // 延迟注册：避免触发菜单的本次事件立即关闭
  window.setTimeout(() => {
    doc.addEventListener("pointerdown", onOutside, true);
    doc.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    doc.addEventListener("scroll", onScrollCap, true);
  }, 0);

  activeCleanup = () => {
    menu.remove();
    doc.removeEventListener("pointerdown", onOutside, true);
    doc.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", onScroll, true);
    doc.removeEventListener("scroll", onScrollCap, true);
  };
}
