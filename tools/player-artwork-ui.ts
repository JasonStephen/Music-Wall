import { CoverBackdrop } from '../src/ui/CoverBackdrop';
import { overrideCoverRequests, requestUrl, probeCoverUri } from './obsidian-shim';
const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(test: () => boolean, ms = 2500): Promise<void> {
  const end = performance.now() + ms;
  while (!test() && performance.now() < end) await tick(25);
}
export async function verifyCoverBackdrop(check: (value: unknown, label: string) => void): Promise<void> {
  const root = document.body.createDiv({ cls: 'mw-view mw-player mw-bg--art' });
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:-1';
  const backdrop = new CoverBackdrop(root);
  const bytes = (await requestUrl({ url: 'https://example.test/accent-probe-f0d060' })).arrayBuffer;
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  let painted = false;
  try {
    overrideCoverRequests(async url => {
      if (url.includes('800y800')) throw Error('Large image unavailable');
      await gate; return bytes;
    });
    backdrop.set('https://example.test/search-cover.jpg', () => painted = true);
    await tick(60);
    check(!painted && !root.classList.contains('has-backdrop') && backdrop.tone === null, 'Pending background keeps readable fallback without a premature palette');
    release();await until(() => !!backdrop.tone);
    check(painted && root.classList.contains('has-backdrop') && !!backdrop.tone, 'Search cover falls back from unavailable large image to a decoded small image');
    const image = root.querySelectorAll<HTMLElement>('.mw-player__backdrop')[1].style.backgroundImage;
    let newest = false;
    backdrop.set(probeCoverUri('225588'), () => newest = true);await until(() => newest, 3000);
    check(newest && [...root.querySelectorAll<HTMLElement>('.mw-player__backdrop')].some(el => el.style.backgroundImage !== image && el.style.opacity === '1'), 'A new song replaces the previous background');
    backdrop.set('https://example.test/failing-cover.jpg', () => {});
    await tick(30);backdrop.set(probeCoverUri('335577'), () => {});await tick(800);
    check([...root.querySelectorAll<HTMLElement>('.mw-player__backdrop')].some(el => el.style.opacity === '1' && el.style.backgroundImage.includes('335577')), 'Stale requests cannot overwrite the latest song cover');
  } finally { release();overrideCoverRequests(null);backdrop.dispose();root.remove(); }
  const retryRoot = document.body.createDiv();const retried = new CoverBackdrop(retryRoot);
  let recovered = false;
  try {
    // Invalid data decodes deterministically; a subsequent valid request must work.
    retried.set('data:image/png;base64,bad', () => {});await tick(100);
    check(!retryRoot.classList.contains('has-backdrop'), 'Failed initial background does not hide the fallback surface');
    retried.set(probeCoverUri('446688'), () => recovered = true);await until(() => recovered);
    check(recovered, 'Background loading recovers after an image failure');
  } finally { retried.dispose();retryRoot.remove(); }
}
