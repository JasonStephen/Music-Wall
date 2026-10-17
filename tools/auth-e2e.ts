// Real login modal + browser DOM, deterministic anonymous responses.
// npx esbuild tools/auth-e2e.ts --bundle --outfile=tools/auth-e2e.bundle.js --alias:obsidian=./tools/obsidian-shim.ts
import { NeteaseLoginModal } from "../src/ui/NeteaseLoginModal";
import { installDomHelpers } from "./obsidian-shim";
import { setLanguage, t } from "../src/i18n";
import type { Requester } from "../src/core/metadata";
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const params = new URLSearchParams(location.search);
setLanguage(params.get("lang") === "en" ? "en" : params.get("lang") === "zh-TW" ? "zh-TW" : "zh-CN");
if (params.get("theme") === "dark") document.body.classList.add("theme-dark");
installDomHelpers();
const results = document.getElementById("result")!;
const failed: string[] = [];
function check(condition: unknown, name: string) {
  results.createEl("div", { text: `${condition ? "PASS" : "FAIL"} ${name}`, cls: condition ? "ok" : "bad" });
  if (!condition) failed.push(name);
}
const request: Requester = async (req) => ({
  status: 200,
  text: JSON.stringify(req.url.endsWith("/unikey") ? { code: 200, unikey: "anonymous-test-qr" } : { code: 801 }),
  headers: { "set-cookie": "NMTID=test; Path=/; HttpOnly" },
});
(async () => {
  const modal = new NeteaseLoginModal({} as never, request, async () => true);
  modal.open();
  await wait(100);
  const image = modal.contentEl.querySelector("img")!;
  // dump-dom can stop before a decode() promise resolves; keep the probe bounded.
  await Promise.race([image.decode(), wait(250)]);
  check(image.naturalWidth > 0 && !image.hidden, "QR image renders locally");
  check(modal.contentEl.querySelector("[role=status]")?.textContent === t("auth.waiting"), "Waiting state is announced");
  check(modal.contentEl.querySelectorAll("button").length === 2, "Refresh and cancel controls exist");
  const imageRect = image.getBoundingClientRect();
  check(imageRect.left >= 0 && imageRect.right <= innerWidth, "QR code fits viewport");
  const buttons = [...modal.contentEl.querySelectorAll("button")];
  check(buttons.every((button) => button.getBoundingClientRect().right <= innerWidth), "Buttons fit viewport");
  if (params.has("preview")) {
    results.hidden = true;
    document.title = failed.length ? "FAIL:" + failed.join("|") : "PASS:auth-preview";
    return;
  }
  buttons[0].click();
  await wait(60);
  check(!image.hidden, "Refreshing replaces the QR code");
  buttons[1].click();
  check(await modal.result === false, "Cancel resolves without logging in");
  check(!document.querySelector(".mw-login-modal"), "Cancel removes the modal");
  document.title = failed.length ? "FAIL:" + failed.join("|") : "PASS:auth-e2e";
})().catch((error) => { document.title = "FAIL:" + error.message; });
