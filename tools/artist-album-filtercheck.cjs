const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
function load(entry, overrides = {}) {
  const result = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', external: ['obsidian'], write: false });
  const module = { exports: {} };
  const host = new Proxy({}, { get: (_, key) => overrides[key] || (key === 'Platform' ? {} : class {}) });
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, name => name === 'obsidian' ? host : require(name));
  return module.exports;
}
const { artistAlbumFilterKey, DEFAULT_ARTIST_ALBUM_KEYWORDS } = load('src/core/artistAlbumFilters.ts');
const { MusicLibraryApi } = load('src/core/library.ts');
const { MusicLibraryView } = load('src/ui/MusicLibraryView.ts');
const rows = Array.from({ length: 243 }, (_, i) => ({ id: i + 1, name: i % 4 === 0 ? `Title ReMiX ${i}` : `Album ${i}`, size: i % 3 === 0 ? 1 : i % 11 === 0 ? 0 : 8 }));
function setup(data = rows) {
  const api = new MusicLibraryApi(() => {}), calls = [];
  api.call = async (path, args) => {
    calls.push(args);
    if (path === '/api/artist/top/song') return { songs: [{ id: 7, name: 'Top song' }] };
    const page = data.slice(args.offset, args.offset + args.limit);
    return { hotAlbums: page, more: args.offset + page.length < data.length };
  };
  return { api, calls };
}
(async () => {
  for (const singles of [false, true]) for (const remixes of [false, true]) {
    const { api, calls } = setup();
    const filters = { artistAlbumHideSingles: singles, artistAlbumHideRemixes: remixes };
    const expected = rows.filter(row => (!singles || row.size > 1) && (!remixes || !/remix/i.test(row.name)));
    const found = []; let offset = 0, page;
    do {
      page = await api.artistAlbums(42, '', offset, filters);
      assert.equal(page.albums.length, Math.min(30, expected.length - found.length));
      assert.ok(page.nextOffset > offset);
      found.push(...page.albums.map(item => item.albumId)); offset = page.nextOffset;
    } while (page.more);
    assert.deepEqual(found, expected.map(row => row.id));
    assert.equal(new Set(found).size, found.length);
    assert.ok(calls.every(call => call.limit > 0 && call.limit <= 30));
  }
  const hidden = setup(rows.map(row => ({ ...row, size: 1 })));
  assert.deepEqual((await hidden.api.artistAlbums(42, '', 0, { artistAlbumHideSingles: true })).albums, []);
  assert.ok(hidden.calls.length > 1);
  const empty = setup(); empty.api.call = async () => ({ hotAlbums: [], more: true });
  assert.equal((await empty.api.artistAlbums(42, '')).more, false);
  const cancelled = setup();
  await assert.rejects(cancelled.api.artistAlbums(42, '', 0, {}, () => false)); assert.equal(cancelled.calls.length, 0);
  const failed = setup(); failed.api.call = async () => { throw Error('offline'); };
  await assert.rejects(failed.api.artistAlbums(42, ''));
  const snapshot = setup(), filters = { artistAlbumHideSingles: true };
  const original = snapshot.api.call;
  snapshot.api.call = async (...args) => { filters.artistAlbumHideSingles = false; return original(...args); };
  assert.ok((await snapshot.api.artistAlbums(42, '', 0, filters)).albums.every(item => item.trackCount > 1));
  const detail = await setup().api.artistDetail({ id: 42, name: 'Artist', cover: '' }, '', { artistAlbumHideSingles: true });
  assert.equal(detail.albums.length, 30); assert.equal(detail.tracks[0].id, 7);

  // Exercise the actual view orchestration without a browser or Obsidian network access.
  const { api } = setup();
  const view = Object.create(MusicLibraryView.prototype);
  Object.assign(view, { plugin: { settings: { neteaseCookie: '', artistAlbumHideSingles: true, artistAlbumHideRemixes: true }, libraryApi: api }, generation: 0, closed: false, body: { scrollTop: 123 }, artistSection: 'albums', render() {} });
  view.artist = await api.artistDetail({ id: 42, name: 'Artist', cover: '' }, '', view.plugin.settings);
  const first = view.artist.albums.map(item => item.albumId);
  await view.loadArtistAlbums();
  assert.equal(view.artist.albums.length, 60); assert.equal(view.body.scrollTop, 123);
  assert.deepEqual(view.artist.albums.slice(0, 30).map(item => item.albumId), first);
  view.plugin.settings.artistAlbumHideSingles = false;
  await view.reloadArtistAlbums();
  assert.equal(view.artist.albums.length, 30); assert.equal(view.artistSection, 'albums');
  assert.equal(view.artist.filterKey, artistAlbumFilterKey(view.plugin.settings));
  assert.ok(view.artist.albums.some(item => item.trackCount === 1));
  const special = setup([
    { id: 1, name: 'Original', size: 2 }, { id: 2, name: 'Album (Live)', size: 4 },
    { id: 3, name: 'Album \uff08Live\uff09', size: 4 }, { id: 4, name: 'VERSION', size: 4 },
    { id: 5, name: 'ReMiX', size: 4 }, { id: 6, name: 'Studio', size: 5 },
    { id: 7, name: 'Unknown' },
  ]);
  assert.equal(DEFAULT_ARTIST_ALBUM_KEYWORDS, 'remix');
  assert.deepEqual((await special.api.artistAlbums(42, '', 0, { artistAlbumHideRemixes: true })).albums.map(a => a.albumId), [1, 2, 3, 4, 6, 7]);
  assert.deepEqual((await special.api.artistAlbums(42, '', 0, { artistAlbumHideSingles: true, artistAlbumTrackLimit: 4 })).albums.map(a => a.albumId), [6, 7]);
  assert.deepEqual((await special.api.artistAlbums(42, '', 0, { artistAlbumHideRemixes: true, artistAlbumKeywords: ' studio ; ORIGINAL\uff1b; ' })).albums.map(a => a.albumId), [2, 3, 4, 5, 7]);
  assert.equal((await special.api.artistAlbums(42, '', 0, { artistAlbumHideRemixes: true, artistAlbumKeywords: '' })).albums.length, 7);

  // Both settings and the dropdown use this form: edits and reset stay local until Apply.
  const formRows = [];
  class Control {
    inputEl = {};
    setValue(value) { this.value = value; return this; }
    setButtonText(value) { this.label = value; return this; }
    setCta() { return this; }
    setDisabled(value) { this.disabled = value; return this; }
    onChange(handler) { this.change = handler; return this; }
    onClick(handler) { this.click = handler; return this; }
  }
  class Setting {
    controls = []; settingEl = { addClass() {} };
    constructor() { formRows.push(this); }
    setName() { return this; } setDesc() { return this; }
    add(callback) { const control = new Control(); this.controls.push(control); callback(control); return this; }
    addToggle(cb) { return this.add(cb); } addText(cb) { return this.add(cb); }
    addTextArea(cb) { return this.add(cb); } addButton(cb) { return this.add(cb); }
  }
  const { renderArtistAlbumSettings } = load('src/ui/artistAlbumSettings.ts', { Setting });
  let writes = 0, refreshes = 0, saved, failWrite = false;
  const plugin = { settings: { artistAlbumHideSingles: false, artistAlbumHideRemixes: false, artistAlbumTrackLimit: 1, artistAlbumKeywords: DEFAULT_ARTIST_ALBUM_KEYWORDS }, async saveData(value) { if (failWrite) throw Error('disk'); writes++; saved = value; }, refreshOpenViews() { refreshes++; } };
  renderArtistAlbumSettings({ createDiv: () => ({ empty() { formRows.length = 0; } }) }, plugin);
  formRows[0].controls[0].change(true); formRows[1].controls[0].change('3');
  formRows[2].controls[0].change(true); formRows[3].controls[0].change('Live;Demo');
  assert.equal(writes, 0); assert.equal(plugin.settings.artistAlbumHideSingles, false);
  await formRows[4].controls[1].click();
  assert.equal(writes, 1); assert.equal(refreshes, 1); assert.equal(saved.artistAlbumTrackLimit, 3);
  assert.equal(plugin.settings.artistAlbumKeywords, 'Live;Demo');
  formRows[4].controls[0].click();
  assert.equal(writes, 1); assert.equal(plugin.settings.artistAlbumTrackLimit, 3);
  assert.equal(formRows[1].controls[0].value, '1'); assert.equal(formRows[3].controls[0].value, DEFAULT_ARTIST_ALBUM_KEYWORDS);
  formRows[1].controls[0].change('-1'); await formRows[4].controls[1].click(); assert.equal(writes, 1);
  formRows[1].controls[0].change('2.5'); await formRows[4].controls[1].click(); assert.equal(writes, 1);
  formRows[1].controls[0].change(''); await formRows[4].controls[1].click(); assert.equal(writes, 1);
  formRows[1].controls[0].change('1'); failWrite = true; await formRows[4].controls[1].click();
  assert.equal(plugin.settings.artistAlbumTrackLimit, 3); assert.equal(refreshes, 1);
  failWrite = false; await formRows[4].controls[1].click();
  assert.equal(plugin.settings.artistAlbumTrackLimit, 1); assert.equal(plugin.settings.artistAlbumKeywords, DEFAULT_ARTIST_ALBUM_KEYWORDS);
  console.log('Artist album filters passed: four switch combinations, full pages, exact order, no omissions/duplicates, final page, all hidden, empty response, cancellation, errors, settings snapshot, artist detail and view pagination/reload.');
})().catch(error => { console.error(error); process.exitCode = 1; });
