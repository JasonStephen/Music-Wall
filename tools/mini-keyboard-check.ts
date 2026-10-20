import { MiniPlayer } from "../src/ui/MiniPlayer";

export async function verifyMiniKeyboard(root: HTMLElement, plugin: any, activate: (active: boolean) => void) {
  const failures: string[] = []; let checks = 0;
  const expect = (value: unknown, label: string) => { checks++; if (!value) failures.push(label); };
  const engine = plugin.internalPlayer, doc = root.ownerDocument;
  const wait = () => new Promise(resolve => setTimeout(resolve, 25));
  const space = async (target: EventTarget = doc, options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true, ...options });
    target.dispatchEvent(event); await wait(); return event;
  };
  (doc.activeElement as HTMLElement)?.blur(); activate(true); await engine.pause();
  expect((await space()).defaultPrevented && engine.state.status === "playing", "Space resumes from a mini-player page without scrolling");
  expect((await space(root)).defaultPrevented && engine.state.status === "paused", "Space in page content pauses shared playback");
  expect((await space(doc, { repeat: true })).defaultPrevented && engine.state.status === "paused", "Holding Space neither repeats nor scrolls");
  for (const options of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }]) {
    expect(!(await space(doc, options)).defaultPrevented && engine.state.status === "paused", "Modified and composing Space remain available");
  }
  for (const tag of ["input", "textarea", "select", "button", "a", "div"]) {
    const el = doc.createElement(tag); if (tag === "a") el.setAttribute("href", "#"); if (tag === "div") el.contentEditable = "true";
    root.append(el); expect(!(await space(el)).defaultPrevented && engine.state.status === "paused", `Space preserves ${tag} behavior`); el.remove();
  }
  const modal = doc.createElement("div"); modal.className = "modal-container"; modal.style.cssText = "position:fixed;width:100px;height:100px"; doc.body.append(modal);
  expect(!(await space()).defaultPrevented && engine.state.status === "paused", "An open modal blocks page playback shortcuts even when body owns focus"); modal.remove();
  activate(false); expect(!(await space()).defaultPrevented && engine.state.status === "paused", "Inactive music tabs never handle Space"); activate(true);
  const other = doc.createElement("div"); other.className = "mw-view"; doc.body.append(other);
  const extra = new MiniPlayer(other, plugin, () => false);
  expect((await space()).defaultPrevented && engine.state.status === "playing", "Multiple mini players toggle playback only once"); extra.dispose(); other.remove();
  await engine.pause(); const event = new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true }); event.preventDefault(); doc.dispatchEvent(event); await wait();
  expect(engine.state.status === "paused", "Already handled Space does not toggle playback");
  return { checks, fail: failures };
}
