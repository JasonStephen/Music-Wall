// 模态框换肤开关。
//
// 为什么需要：Obsidian 的模态框挂在 document.body 上，**不在 .mw-view 子树里**，
// 拿不到展示架在根节点上放的那套木色 token。于是展示架模式下弹窗仍是主题的
// 白底 + 紫色强调色，和背后的木墙完全是两个世界（用户第五轮反馈 A3）。
//
// 做法：视图渲染时登记「当前墙是什么长相」（setModalTheme），各模态框 onOpen 里
// 调 applyModalTheme(this.modalEl) 给 .modal 挂上作用域类，配色交给 modals.css。
// 视图渲染发生在用户操作之前，因此登记值总是与用户正在看的墙一致；
// 多墙并存（一面展示架 + 一面网格）时以最后渲染的那面为准，属于可接受的取舍。

export type ModalThemeName = "default" | "shelf";

let current: ModalThemeName = "default";

/** 视图渲染时登记：展示架墙 = "shelf"，其它布局与播放器 = "default" */
export function setModalTheme(theme: ModalThemeName): void {
  current = theme;
}

/** 模态框 onOpen 里调用：把当前皮肤挂到 .modal 上（默认皮肤不挂类，等于无操作） */
export function applyModalTheme(modalEl: HTMLElement): void {
  modalEl.toggleClass("mw-modal--shelf", current === "shelf");
}
