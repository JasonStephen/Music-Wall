const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const result = buildSync({ entryPoints: ['src/core/store.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['obsidian'] });
const loaded = { exports: {} };
new Function('module', 'exports', 'require', result.outputFiles[0].text)(loaded, loaded.exports, require);
const { parseWall } = loaded.exports;
const item = (albumId, extra = {}) => ({ albumId, source: 'manual', locked: false, addedAt: '2024-01-01', meta: { albumId, name: 'Album', artist: '', cover: '' }, ...extra });

assert.deepEqual(Object.keys(loaded.exports), ['parseWall']);
assert.throws(() => parseWall('{broken'));
assert.throws(() => parseWall('null'));
assert.throws(() => parseWall('{}'));
assert.throws(() => parseWall(JSON.stringify({ version: 999, items: [] })));
const legacy = parseWall(JSON.stringify({ version: 1, style: 'cd', items: [item(1, { groupId: 'missing' })] }));
assert.equal(legacy.version, 3);
assert.equal(legacy.style, 'cd');
assert.equal(legacy.items[0].groupId, undefined);
assert.equal(legacy.groups, undefined);
assert.equal(legacy.order, undefined);

const current = parseWall(JSON.stringify({
  version: 3, name: 'Git wall', style: 'vinyl', layout: 'shelf',
  items: [item(1, { groupId: 'g1', rating: 5 }), item(2, { groupId: 'missing', rating: 9 })],
  groups: [{ id: 'g1', name: 'Group', collapsed: true }, { id: 'g1', name: 'Duplicate' }, { id: '', name: 'Invalid' }],
  order: [2, 'bad', 1, null], ungroupedCollapsed: true,
  view: { sortMode: 'manual', sortAsc: false, filterArtists: ['Artist', 'Artist', ''], filterRatings: [0, 5, 5, 8] },
}));
assert.equal(current.name, 'Git wall');
assert.equal(current.layout, 'shelf');
assert.deepEqual(current.groups, [{ id: 'g1', name: 'Group', collapsed: true }]);
assert.equal(current.items[0].groupId, 'g1');
assert.equal(current.items[1].groupId, undefined);
assert.equal(current.items[0].rating, 5);
assert.equal(current.items[1].rating, undefined);
assert.deepEqual(current.order, [2, 1]);
assert.equal(current.ungroupedCollapsed, true);
assert.deepEqual(current.view, { sortMode: 'manual', sortAsc: false, filterArtists: ['Artist'], filterRatings: [0, 5] });
assert.deepEqual(parseWall(JSON.stringify(current)), current);
console.log('Wall parser checks passed: Git compatibility, legacy schemas, groups, order, metadata validation and invalid-file rejection.');
