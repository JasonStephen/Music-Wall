import { GitSyncModal } from "../src/ui/GitSyncModal";
import { GitHubLoginModal } from "../src/ui/GitHubLoginModal";
import type { GitHubAccountController } from "../src/core/githubAuth";
import { buildSyncPlan } from "../src/core/wallSync";
import { setLanguage } from "../src/i18n";
import { t } from "../src/i18n";
import { installDomHelpers } from "./obsidian-shim";
installDomHelpers();
const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const wall = (name: string) => JSON.stringify({ version: 2, name, style: "vinyl", items: [] }, null, 2);
const local = [{ path: "MusicWall/Japan.mw", content: wall("Local") }, { path: "MusicWall/Sub/A very long album collection name · 电影配乐.mw", content: wall("Shared") }, { path: "root.mw", content: wall("Root") }, { path: "invalid.mw", content: "bad" }];
const remote = [{ path: "MusicWall/Japan.mw", content: wall("Remote") }, { path: "MusicWall/Sub/A very long album collection name · 电影配乐.mw", content: wall("Shared") }, { path: "remote-only.mw", content: wall("Remote only") }];
let current: GitSyncModal | null = null;
(window as any).checkMobileGitSyncUI = async () => {
  current?.close(); document.querySelectorAll('.modal-container').forEach(node => node.remove());
  document.body.classList.add('is-mobile','is-tablet');
  const failures: string[] = []; let checks = 0, applies = 0, signal: AbortSignal | undefined;
  const check = (ok: unknown, label: string) => { checks++; if (!ok) failures.push(label); };
  current = new GitSyncModal({} as never, {repoUrl:'https://github.com/user/walls',branch:'main',localDirectory:'',remoteDirectory:'walls'}, async (_config,direction,operation) => {
    signal = operation; check(direction === 'pull', 'Mobile preview only reads');
    return {plan:buildSyncPlan('pull',local,remote),branch:'main',commit:'abcdef123456789',async apply(selected,applySignal) {
      check(applySignal === signal && !applySignal?.aborted, 'Confirmation receives the active cancellation signal');
      check(!selected.has('root.mw'), 'Mobile confirmation excludes local-only walls'); applies++; return selected.size;
    }};
  }, 'pull', () => {}, undefined, true);
  current.open(); await wait(15);
  const modal = current.contentEl;
  check(current.modalEl.scrollWidth <= current.modalEl.clientWidth + 1, 'Mobile sync has no horizontal overflow');
  const bounds = current.modalEl.getBoundingClientRect();
  check(bounds.left >= -1 && bounds.right <= innerWidth + 1, 'Mobile sync fits the viewport');
  for (const button of modal.querySelectorAll<HTMLElement>('button')) {
    if (!button.getClientRects().length) continue;
    const rect = button.getBoundingClientRect();
    check(rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1, 'Mobile buttons remain inside the sync dialog');
  }
  check(!modal.querySelector('[data-preview="push"]'), 'Mobile does not offer unsupported push');
  check(!modal.querySelector('[data-action="github-manage"]'), 'Public pull does not require desktop sign-in');
  check(modal.textContent?.includes(t('githubPull.hint')), 'Mobile public-repository support is explained');
  const selected = [...modal.querySelectorAll<HTMLInputElement>('[data-path] input:checked')];
  check(selected.length === 3, 'Mobile defaults select all remote wall files');
  modal.querySelector<HTMLButtonElement>('[data-path] .mw-git-sync__filename')?.click();
  check(modal.querySelectorAll('.mw-git-sync__diff pre').length === 2, 'Mobile can inspect both sides before applying');
  check(applies === 0, 'Preview never writes files');
  modal.querySelector<HTMLButtonElement>('[data-action="apply-sync"]')!.click(); await wait(15);
  check(applies === 1, 'Mobile writes only after explicit confirmation');
  modal.querySelector<HTMLButtonElement>('[data-preview="pull"]')!.click(); await wait(15);
  current.close(); check(signal?.aborted, 'Closing a mobile preview cancels its operation');
  return {checks,failures};
};
(window as any).checkGitSyncUI = async (config: { lang: "zh-CN" | "zh-TW" | "en"; theme: string; zoom: number; shelf: boolean }) => {
  current?.close(); document.querySelectorAll('.modal-container').forEach(node => node.remove());
  setLanguage(config.lang); document.body.className = `theme-${config.theme}`;
  document.body.style.setProperty('--mw-zoom', String(config.zoom));
  const failures: string[] = []; let checks = 0, applied = 0, prepared = 0;
  let account = "alice";
  const check = (value: unknown, label: string) => { checks++; if (!value) failures.push(label); };
  current = new GitSyncModal({} as never, { repoUrl: "https://github.com/user/walls.git", branch: "", localDirectory: "", remoteDirectory: "" }, async (_config, direction) => {
    prepared++; await wait();
    return { plan: buildSyncPlan(direction, local, remote), branch: "main", commit: "abcdef123456789", async apply(selected) { applied++; await wait(20); return direction === "push" ? 1 : 2; } };
  }, "push", () => {}, { name: () => account, open: async () => { account = "bob"; return true; } });
  current.open(); await wait(15);
  const modal = document.querySelector<HTMLElement>('.mw-git-sync')!;
  const row = (path: string) => [...modal.querySelectorAll<HTMLElement>('[data-path]')].find(node => node.dataset.path === path)!;
  const checkbox = (path: string) => row(path).querySelector<HTMLInputElement>('input')!;
  const apply = modal.querySelector<HTMLButtonElement>('[data-action="apply-sync"]')!;
  check(checkbox('MusicWall/Japan.mw').checked && !checkbox('root.mw').checked, 'Push defaults select .mw folders but exclude standalone vault-root files');
  check(checkbox('invalid.mw').disabled && checkbox('remote-only.mw').disabled, 'Invalid sources and target-only files cannot be selected');
  check(modal.querySelector<HTMLInputElement>('[data-field="repoUrl"]')!.value.includes('github.com'), 'Saved configuration is visible');
  check(!apply.disabled, 'A reviewed change can be confirmed');
  checkbox('MusicWall/Japan.mw').click();
  check([...modal.querySelectorAll<HTMLInputElement>('summary input')].some(input => input.indeterminate), 'Partially selected folders use indeterminate checkboxes');
  const folder = modal.querySelector<HTMLInputElement>('summary input')!; folder.click();
  check(checkbox('MusicWall/Japan.mw').checked, 'Selecting a folder selects its descendant files');
  row('MusicWall/Japan.mw').querySelector<HTMLButtonElement>('button')!.click();
  check(modal.querySelectorAll('.mw-git-sync__diff pre').length === 2 && !!modal.querySelector('.is-different'), 'File differences show highlighted local and remote content');
  const bounds = modal.getBoundingClientRect();
  check(bounds.left >= -1 && bounds.right <= innerWidth + 1, 'Sync window fits its viewport');
  check(modal.scrollWidth <= modal.clientWidth + 1, 'Sync window has no horizontal overflow');
  for (const field of modal.querySelectorAll<HTMLInputElement>('.mw-git-sync__fields input')) {
    const rect = field.getBoundingClientRect(); check(rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1, 'Configuration fields stay inside modal');
  }
  const tree = modal.querySelector<HTMLElement>('.mw-git-sync__tree')!;
  check(tree.scrollHeight <= tree.clientHeight + 1 || getComputedStyle(tree).overflowY === 'auto', 'File tree scrolls when necessary');
  check(tree.scrollWidth <= tree.clientWidth + 1, 'File paths wrap inside the tree');
  apply.scrollIntoView({block:'center'});
  const buttonRect=apply.getBoundingClientRect();
  check(buttonRect.top>=0&&buttonRect.bottom<=innerHeight+1,'Confirmation remains reachable inside the viewport');
  modal.querySelector<HTMLButtonElement>('[data-preview="pull"]')!.click(); await wait(15);
  check(checkbox('MusicWall/Japan.mw').checked && checkbox('remote-only.mw').checked, 'Pull defaults select all remote walls');
  check(!checkbox('root.mw').checked && checkbox('root.mw').disabled, 'Pull preserves local-only walls');
  const field = modal.querySelector<HTMLInputElement>('[data-field="remoteDirectory"]')!;
  field.value = 'Shared'; field.dispatchEvent(new Event('input'));
  check(apply.disabled && !modal.querySelector('[data-path]'), 'Changing directory mappings invalidates the preview');
  modal.querySelector<HTMLButtonElement>('[data-preview="pull"]')!.click(); await wait(15);
  apply.click(); apply.click();
  check(apply.disabled && field.disabled, 'Applying disables configuration and duplicate confirmation');
  await wait(35);
  check(applied === 1 && prepared === 3, 'One confirmation runs exactly one reviewed sync');
  check(apply.disabled && !modal.querySelector('[data-path]'), 'A completed snapshot cannot be applied again');
  modal.querySelector<HTMLButtonElement>('[data-preview="pull"]')!.click(); await wait(15);
  const manage = modal.querySelector<HTMLButtonElement>('[data-action="github-manage"]')!;
  check(manage.textContent!.includes('alice'), 'Sync window shows the selected account');
  manage.click(); await wait(15);
  check(manage.textContent!.includes('bob') && apply.disabled && !modal.querySelector('[data-path]'), 'Changing account updates the label and invalidates the reviewed snapshot');
  // Restore a populated snapshot for visual inspection.
  modal.querySelector<HTMLButtonElement>('[data-preview="pull"]')!.click(); await wait(15);
  row('MusicWall/Japan.mw').querySelector<HTMLButtonElement>('button')!.click();
  return { checks, failures };
};

(window as any).checkGitHubAuthUI = async () => {
  current?.close();
  const failures: string[] = []; let checks = 0, selected = "alice", saves = 0, logins = 0;
  const check = (value: unknown, label: string) => { checks++; if (!value) failures.push(label); };
  let loginSignal: AbortSignal | undefined;
  let completeLogin: ((value: {available: boolean; accounts: string[]}) => void) | undefined;
  const controller: GitHubAccountController = {
    selected: () => selected,
    inspect: async () => ({ available: true, accounts: ['alice'] }),
    login: async signal => { logins++; loginSignal = signal; return new Promise(resolve => { completeLogin = resolve; }); },
    select: async account => { saves++; selected = account; },
  };
  let modal = new GitHubLoginModal({} as never, controller); modal.open(); await wait(10);
  const button = (action: string) => modal.contentEl.querySelector<HTMLButtonElement>(`[data-action="github-${action}"]`)!;
  const account = () => modal.contentEl.querySelector<HTMLSelectElement>('select')!;
  check(account().value === 'alice' && !button('use').disabled, 'Saved account can be selected without logging in again');
  check(!modal.contentEl.querySelector('input'), 'Login form never requests a password or token');
  check(modal.contentEl.querySelector<HTMLAnchorElement>('a')!.href.startsWith('https://github.com/git-ecosystem/'), 'Installation help links to GCM');
  button('login').click(); button('login').click();
  check(logins === 1 && button('use').disabled && button('refresh').disabled && account().disabled, 'Pending authorization blocks duplicate login and account changes');
  check(saves === 0, 'Starting browser login does not save or sync anything');
  completeLogin!({ available: true, accounts: ['alice', 'bob'] }); await wait(10);
  check(account().value === 'bob' && !button('use').disabled, 'Newly authorized account is selected for explicit confirmation');
  const bounds = modal.modalEl.getBoundingClientRect();
  check(bounds.left >= -1 && bounds.right <= innerWidth + 1 && modal.modalEl.scrollWidth <= modal.modalEl.clientWidth + 1, 'Login dialog fits narrow and zoomed viewports');
  for (const control of modal.contentEl.querySelectorAll<HTMLElement>('button,select')) {
    const rect = control.getBoundingClientRect(); check(rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1, 'Login controls stay inside the dialog');
  }
  button('use').scrollIntoView({block:'center'});
  const rect=button('use').getBoundingClientRect(); check(rect.top>=0&&rect.bottom<=innerHeight+1,'Account confirmation remains reachable');
  button('use').click(); await wait(10);
  check(selected === 'bob' && saves === 1 && !modal.containerEl.isConnected, 'Confirmed account is saved exactly once');
  modal = new GitHubLoginModal({} as never, controller); modal.open(); await wait(10);
  button('disconnect').click(); await wait(10);
  check(!selected && saves === 2, 'Returning to system credentials clears only the plugin account binding');
  modal = new GitHubLoginModal({} as never, controller); modal.open(); await wait(10);
  button('login').click(); modal.close();
  check(loginSignal!.aborted, 'Closing the dialog aborts pending authorization');
  completeLogin!({ available: true, accounts: ['late-account'] }); await wait(10);
  check(!modal.containerEl.isConnected && !selected && saves === 2, 'Late authorization cannot save an account after close');
  modal = new GitHubLoginModal({} as never, { ...controller, inspect: async () => ({available:false,accounts:[]}) }); modal.open(); await wait(10);
  check(button('login').disabled && button('use').disabled && !button('refresh').disabled, 'Missing GCM offers install and refresh without starting a broken login');
  modal.close();
  modal = new GitHubLoginModal({} as never, { ...controller, login: async () => { throw Error('Authorization failed'); } }); modal.open(); await wait(10);
  button('login').click(); await wait(10);
  check(!button('login').disabled && !!modal.contentEl.querySelector('.is-error'), 'Failed authorization is visible and can be retried');
  modal.close();
  modal = new GitHubLoginModal({} as never, { ...controller, select: async () => { throw Error('disk unavailable'); } }); modal.open(); await wait(10);
  button('use').click(); await wait(10);
  check(!button('use').disabled && !!modal.contentEl.querySelector('.is-error') && modal.containerEl.isConnected, 'Failed account save keeps the dialog open for retry');
  modal.close();
  // Leave a normal account dialog visible for screenshot inspection.
  modal = new GitHubLoginModal({} as never, controller); modal.open(); await wait(10);
  return {checks, failures};
};
