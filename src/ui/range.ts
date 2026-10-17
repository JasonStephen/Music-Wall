/** Native range keeps keyboard/touch accessibility; CSS draws the filled track. */
export function paintRange(input: HTMLInputElement): void {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 1;
  const percent = Math.max(0, Math.min(100, (Number(input.value) - min) / (max - min || 1) * 100));
  input.style.setProperty("--mw-range-percent", `${percent}%`);
  const wrapper = input.parentElement;
  if (wrapper?.classList.contains("mw-slider")) {
    wrapper.style.setProperty("--mw-range-percent", `${percent}%`);
    wrapper.style.setProperty("--mw-range-ratio", String(percent / 100));
  }
}

/** Draw the track/thumb separately so host range styles cannot offset the visible thumb. */
export function decorateRange(input: HTMLInputElement, vertical = false): void {
  const wrapper = input.ownerDocument.createElement("div");
  wrapper.className = `mw-slider${vertical ? " mw-slider--vertical" : ""}`;
  input.parentElement!.insertBefore(wrapper, input);
  wrapper.appendChild(input);
  wrapper.createSpan({ cls: "mw-slider__track", attr: { "aria-hidden": "true" } });
  wrapper.createSpan({ cls: "mw-slider__thumb", attr: { "aria-hidden": "true" } });
  paintRange(input);
}
