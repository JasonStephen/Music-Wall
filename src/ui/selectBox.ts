// 自绘复选框：彻底重写，内部零原生控件。
//
// 背景：之前用 label + input[type=checkbox] 实现，宿主主题对原生 checkbox 的
// 着色规则（特异性高、带 !important 的都有）反复把样式盖回紫色/双层框，
// CSS 层面打补丁无法根治。这里改用 button[role=checkbox]：框体是 button 自身
// 的边框/背景，对勾是 ::after 自绘——主题没有任何 `input[type=checkbox]`
// 规则能命中它，从根上免疫。
//
// 状态由调用方持有（MusicWallView.selected / BatchAddModal.picked），组件只做
// 受控表达：onToggle 返回新状态，组件据此同步 aria-checked 与 is-checked 类。

export interface SelectBoxOptions {
  /** 初始选中态 */
  checked: boolean;
  /** 悬停提示 */
  title?: string;
  /** 点击时调用，返回切换后的新状态；组件据此刷新自身 */
  onToggle: () => boolean;
}

/** 创建一个自绘复选框按钮 */
export function createSelectBox(opts: SelectBoxOptions): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mw-selectbox";
  btn.setAttribute("role", "checkbox");
  if (opts.title) {
    btn.setAttr("title", opts.title);
    btn.setAttr("aria-label", opts.title);
  }
  syncSelectBox(btn, opts.checked);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    syncSelectBox(btn, opts.onToggle());
  });
  return btn;
}

/** 受控同步选中态（重绘/全选等场景调用，不经过点击） */
export function syncSelectBox(btn: HTMLButtonElement, checked: boolean): void {
  btn.toggleClass("is-checked", checked);
  btn.setAttribute("aria-checked", checked ? "true" : "false");
}
