import { installDomHelpers, Platform } from './obsidian-shim';
import { WallTreePickerModal } from '../src/ui/WallTreePickerModal';
import { setLanguage, t } from '../src/i18n';
import { setModalTheme } from '../src/ui/modalTheme';

installDomHelpers();
const files = [
  'MusicWall/Gaming/Game.mw', 'MusicWall/Synthwave/Synthwave.mw',
  'MusicWall/Japan.mw', 'MusicWall/Gaming/Japan.mw', 'Root.mw',
  'MusicWall/中文/塞壬唱片.mw', 'MusicWall/ＡＢＣ/Fullwidth.mw', 'ignored.md',
  'MusicWall/Very long folder name/another folder/deep/a/b/c/d/e/An extremely long wall name.mw',
  ...Array.from({length: 35}, (_, i) => `MusicWall/Many/Wall ${i}.mw`),
].map(path => ({path, label: path.split('/').pop()!.replace(/\.mw$/, '')}));
let modal: WallTreePickerModal, picked: number[];
function open() {
  modal?.close(); picked = [];
  modal = new WallTreePickerModal({} as any, t('library.addToWall'), files, index => picked.push(index));
  modal.open(); return modal;
}
const rows = () => [...document.querySelectorAll<HTMLButtonElement>('.mw-wall-picker__row')];
const row = (path: string) => rows().find(r => r.dataset.path === path)!;
function search(query: string) {
  const input = document.querySelector<HTMLInputElement>('.mw-wall-picker__search input')!;
  input.value = query; input.dispatchEvent(new Event('input')); return input;
}
function key(el: Element, key: string) { el.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true})); }
(window as any).runPickerChecks = () => {
  let checks = 0; const fail: string[] = [];
  const check = (ok: unknown, message: string) => { checks++; if (!ok) fail.push(message); };
  open();
  check(!!row('MusicWall') && !!row('Root.mw'), 'root folder and wall visible');
  check(!!row('MusicWall/Gaming') && !row('MusicWall/Gaming/Game.mw'), 'nested folders start collapsed');
  check(!rows().some(r => r.dataset.path === 'ignored.md'), 'non wall excluded');
  row('MusicWall/Gaming').click();
  check(!picked.length && !!row('MusicWall/Gaming/Game.mw'), 'folder only expands');
  row('MusicWall/Gaming').click();
  search('gAmInG JAPAN');
  check(rows().filter(r => r.dataset.kind === 'file').map(r => r.dataset.path).join() === 'MusicWall/Gaming/Japan.mw', 'path and name multi term case insensitive');
  check(row('MusicWall/Gaming').getAttribute('aria-expanded') === 'true', 'matches auto expanded');
  search('中文 塞壬'); check(!!row('MusicWall/中文/塞壬唱片.mw'), 'Chinese path search');
  search('abc fullwidth'); check(!!row('MusicWall/ＡＢＣ/Fullwidth.mw'), 'Unicode normalized search');
  search('no such wall'); check(rows().length === 0 && !!document.querySelector('.mw-wall-picker__empty'), 'no results');
  (document.querySelector('.mw-wall-picker__clear') as HTMLButtonElement).click();
  check(!row('MusicWall/Gaming/Game.mw') && row('MusicWall/Gaming').getAttribute('aria-expanded') === 'false', 'clear restores prior expansion');
  check((document.activeElement as HTMLElement)?.tagName === 'INPUT', 'clear returns input focus');
  key(document.activeElement!, 'ArrowDown'); check(document.activeElement === rows()[0], 'search down enters tree');
  key(document.activeElement!, 'End'); check(document.activeElement === rows().at(-1), 'End enters last visible row');
  key(document.activeElement!, 'Home'); check(document.activeElement === rows()[0], 'Home enters first row');
  row('MusicWall/Gaming').focus(); key(document.activeElement!, 'ArrowRight');
  check(!!row('MusicWall/Gaming/Game.mw') && document.activeElement === row('MusicWall/Gaming'), 'right expands retaining focus');
  key(document.activeElement!, 'ArrowRight'); check(document.activeElement === row('MusicWall/Gaming/Game.mw'), 'right enters children');
  key(document.activeElement!, 'ArrowLeft'); check(document.activeElement === row('MusicWall/Gaming'), 'left enters parent');
  search('Gaming Japan'); const leaf = row('MusicWall/Gaming/Japan.mw'); leaf.click(); leaf.click();
  check(picked.length === 1 && picked[0] === 3, 'duplicate name selects original index once');
  check(!document.querySelector('.mw-wall-picker'), 'selection closes modal');
  open(); const stale = row('Root.mw'); modal.close(); stale.click(); check(!picked.length, 'close invalidates stale file click');
  open(); (document.querySelector('.mw-wall-picker__footer button') as HTMLButtonElement).click(); check(!picked.length, 'cancel never selects');
  return {checks, fail};
};
(window as any).pickerLayout = (lang: any, theme: string, zoom: number) => {
  setLanguage(lang); setModalTheme(theme === 'shelf' ? 'shelf' : 'default');
  document.body.className = 'is-tablet ' + (theme === 'dark' ? 'theme-dark' : 'theme-light') + (zoom > 1 ? ' mw-zoomed' : '');
  document.body.style.setProperty('--mw-zoom', String(zoom));
  open(); search('MusicWall');
  const fail: string[] = []; let checks = 0;
  const check = (ok: unknown, msg: string) => { checks++; if (!ok) fail.push(msg); };
  const m = modal.modalEl.getBoundingClientRect();
  check(m.left >= -1 && m.right <= innerWidth + 1 && m.top >= -1 && m.bottom <= innerHeight + 1, 'modal within viewport');
  const footer = document.querySelector('.mw-wall-picker__footer')!.getBoundingClientRect();
  check(footer.bottom <= m.bottom + 1, 'footer visible without outer scroll');
  check(modal.modalEl.scrollWidth <= modal.modalEl.clientWidth + 1, 'no horizontal modal overflow');
  for (const r of rows()) {
    check(r.scrollWidth <= r.clientWidth + 1, 'row overflow ' + r.dataset.path);
    for (const icon of r.querySelectorAll('svg')) {
      const bounds = icon.getBoundingClientRect();
      check(Math.abs(bounds.width - 18 * zoom) < 1 && Math.abs(bounds.height - 18 * zoom) < 1, 'SVG fixed size');
    }
  }
  return {checks, fail};
};
(window as any).preparePickerTouch = () => {
  Platform.isDesktopApp = false; open(); search('Gaming Japan');
  const r = row('MusicWall/Gaming/Japan.mw').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};
};
(window as any).pickerTouchResult = () => ({picked, open: !!document.querySelector('.mw-wall-picker')});
