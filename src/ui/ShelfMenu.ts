// 自绘展示架风格右键菜单：深棕木纹面板，展示架布局下的右键菜单都用它。
// Obsidian 原生 Menu 无法按实例换肤（永远是主题的白底 + 紫色高亮），这里用纯 DOM 实现；
// 菜单项语义与 openCardMenu 的原生菜单一致，由 MusicWallView.showCtxMenu 统一分发。

import { setIcon } from "obsidian";

export interface ShelfMenuItem {
  title: string;
  /** lucide 图标名（与原生菜单保持一致，缺省不占位） */
  icon?: string;
  danger?: boolean;
  /** 置灰不可点（如未打开播放器时的「加入播放器」） */
  disabled?: boolean;
  /** 小标题行（不可点，用于给「移动到分组」这类成组条目分节） */
  heading?: boolean;
  /** 分隔线（对应原生菜单的 addSeparator） */
  separator?: boolean;
  onClick?: () => void;
}

let activeCleanup: (() => void) | null = null;

function closeActive(): void {
  activeCleanup?.();
  activeCleanup = null;
}

/** 在 (x, y) 处弹出展示架风格菜单；点击外部/Esc/滚动关闭 */
export function openShelfMenu(x: number, y: number, items: ShelfMenuItem[]): () => void {
  closeActive();

  const doc = document;
  const menu = doc.createElement("div");
  menu.className = "mw-shelf-menu";
  menu.setAttribute("role", "menu");
  let closed = false;
  let registration = 0;

  for (const item of items) {
    if (item.separator) {
      menu.appendChild(doc.createElement("div")).className = "mw-shelf-menu__sep";
      continue;
    }
    const row = doc.createElement("div");
    if (item.heading) {
      row.className = "mw-shelf-menu__heading";
      row.textContent = item.title;
      menu.appendChild(row);
      continue;
    }
    const classes = ["mw-shelf-menu__item"];
    if (item.danger) classes.push("is-danger");
    if (item.disabled) classes.push("is-disabled");
    row.className = classes.join(" ");
    row.setAttribute("role", "menuitem");
    row.setAttribute("aria-disabled", String(!!item.disabled));
    row.tabIndex = item.disabled ? -1 : 0;
    if (item.icon) {
      const box = doc.createElement("span");
      box.className = "mw-shelf-menu__icon";
      setIcon(box, item.icon);
      row.appendChild(box);
    }
    const label = doc.createElement("span");
    label.className = "mw-shelf-menu__label";
    label.textContent = item.title;
    row.appendChild(label);
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      if (item.disabled || closed) return;
      close();
      item.onClick?.();
    });
    row.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); row.click(); }
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
    if (!menu.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  };
  const onScrollCap = (e: Event) => {
    if (!menu.contains(e.target as Node)) close();
  };

  // 延迟注册：避免触发菜单的本次事件立即关闭
  registration = window.setTimeout(() => {
    if (closed) return;
    doc.addEventListener("pointerdown", onOutside, true);
    doc.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScrollCap, true);
    doc.addEventListener("scroll", onScrollCap, true);
  }, 0);

  const close = () => {
    if (closed) return;
    closed = true; window.clearTimeout(registration);
    menu.remove();
    doc.removeEventListener("pointerdown", onOutside, true);
    doc.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", onScrollCap, true);
    doc.removeEventListener("scroll", onScrollCap, true);
    if (activeCleanup === close) activeCleanup = null;
  };
  activeCleanup = close;
  return close;
}
