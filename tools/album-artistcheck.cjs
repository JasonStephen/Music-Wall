const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
function load(entry) {
  const result = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', external: ['obsidian'], write: false });
  const module = { exports: {} };
  const host = new Proxy({}, { get: (_, key) => key === 'setIcon' ? () => {} : key === 'Platform' ? {} : class {} });
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, name => name === 'obsidian' ? host : require(name));
  return module.exports;
}
class Element {
  children = []; dataset = {}; listeners = {}; attrs = {};
  constructor(tag = 'div', options = {}, parent = null) { this.tag = tag; this.options = options; this.parent = parent; }
  createEl(tag, options = {}) { const el = new Element(tag, options, this); this.children.push(el); return el; }
  createDiv(options) { return this.createEl('div', options); }
  createSpan(options) { return this.createEl('span', options); }
  setAttr(key, value) { this.attrs[key] = value; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  querySelector() { return {}; }
  click() {
    const event = { stopped: false, stopPropagation() { this.stopped = true; } };
    for (let el = this; el && !event.stopped; el = el.parent) el.listeners.click?.(event);
  }
  find(predicate) { return this.children.flatMap(el => [el, ...el.find(predicate)]).filter(predicate); }
}
const { MusicLibraryApi } = load('src/core/library.ts');
const { MusicLibraryView } = load('src/ui/MusicLibraryView.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  const api = new MusicLibraryApi(() => {});
  api.call = async () => ({ result: { albumCount: 2, albums: [
    { id: 5, name: 'Collaboration', size: 12, artists: [{ id: 8, name: 'First', picUrl: 'first.jpg' }, { id: 9, name: 'Second' }] },
    { id: 6, name: 'Solo', size: 3, artists: [], artist: { id: 10, name: 'Solo artist' } },
  ] } });
  const result = await api.searchContent('artist', 'albums', '');
  assert.deepEqual(result.albums[0].artistRefs.map(a => a.id), [8, 9]);
  assert.equal(result.albums[1].artistRefs[0].id, 10);
  const parent = new Element(); let openedAlbum, openedArtist;
  const view = Object.create(MusicLibraryView.prototype);
  Object.assign(view, { cardContainer: p => p.createDiv(), context() {}, cardStats() {}, async openAlbum(album) { openedAlbum = album.albumId; }, async openArtist(artist) { openedArtist = artist; } });
  view.renderAlbums(parent, result.albums);
  const links = parent.find(el => el.options.attr?.['data-link'] === 'artist');
  assert.equal(links.length, 3);
  links[1].click(); await tick(); assert.equal(openedArtist.id, 9); assert.equal(openedAlbum, undefined);
  links[0].click(); await tick(); assert.equal(openedArtist.cover, 'first.jpg');
  links[2].click(); await tick(); assert.equal(openedArtist.id, 10);
  parent.find(el => el.options.cls === 'mw-cloud__album-open')[0].click(); await tick(); assert.equal(openedAlbum, 5);
  assert.equal(parent.find(el => el.tag === 'button').some(button => button.find(el => el.tag === 'button').length), false);
  Object.assign(view, { generation: 0, closed: false, plugin: { settings: { neteaseCookie: '' }, async fetchAlbumDetail() { return { artistRefs: [{ id: 20, name: 'Resolved artist' }] }; } } });
  await view.albumArtist({ albumId: 7 }); assert.equal(openedArtist.id, 20);
  view.plugin.fetchAlbumDetail = async () => { view.generation++; return { artistRefs: [{ id: 99, name: 'Stale' }] }; };
  await view.albumArtist({ albumId: 8 }); assert.equal(openedArtist.id, 20);
  console.log('Album artist navigation passed: API artist IDs, artist fallback, collaboration links, no album click propagation, cover/title opens album, valid button structure, metadata fallback and stale response guard.');
})().catch(error => { console.error(error); process.exitCode = 1; });
