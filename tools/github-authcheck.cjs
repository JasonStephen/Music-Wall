// Mock OAuth commands: no browser sign-in, credentials or network access required.
const assert = require('node:assert/strict'), path = require('node:path');
const built = require('esbuild').buildSync({ entryPoints: [path.join(__dirname, '../src/core/githubAuth.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['obsidian'] });
const load = (override) => {
  const m = { exports: {} };
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(m, m.exports, name => name === 'child_process' && override ? override : require(name));
  return m.exports.GitHubAuth;
};
const GitHubAuth = load();
let passed = 0;
async function test(label, check) { await check(); console.log('PASS ' + label); passed++; }
(async () => {
  await test('Reads saved accounts and launches only the official GCM browser flow', async () => {
    const calls = [];
    const auth = new GitHubAuth(async args => { calls.push(args); return args.includes('--version') ? '2.4.1' : args.includes('list') ? 'alice\r\nbob\r\nalice\r\n' : ''; });
    assert.deepEqual(await auth.inspect(), { available: true, accounts: ['alice', 'bob'] });
    assert.deepEqual((await auth.login()).accounts, ['alice', 'bob']);
    assert.deepEqual(calls.find(args => args.includes('login')), ['credential-manager', 'github', 'login', '--url', 'https://github.com', '--browser', '--no-ui', '--force']);
    assert.ok(!calls.some(args => args.includes('--pat') || args.includes('get') || args.includes('fill')));
  });
  await test('Older manager command is supported and missing installations are reported', async () => {
    const auth = new GitHubAuth(async args => { if (args[0] === 'credential-manager') throw Error('missing'); return args.includes('--version') ? 'version' : 'alice\n'; });
    assert.equal((await auth.inspect()).available, true);
    assert.ok((await auth.gitArguments('https://github.com/user/walls.git', 'alice')).includes('credential.helper=manager-core'));
    const missing = new GitHubAuth(async () => { throw Error('missing'); });
    assert.deepEqual(await missing.inspect(), { available: false, accounts: [] });
    await assert.rejects(() => missing.login(), /Git Credential Manager/);
  });
  await test('Account binding applies only to HTTPS GitHub, never SSH, local paths or lookalike hosts', async () => {
    let calls = 0;
    const auth = new GitHubAuth(async args => { calls++; return args.includes('--version') ? 'version' : 'alice\n'; });
    for (const url of ['git@github.com:user/walls.git', 'ssh://git@github.com/user/walls.git', 'https://github.com.evil.test/user/walls.git', 'https://example.com/walls.git', 'https://github.com:8443/user/walls.git', 'http://github.com/u/r', 'https://bob@github.com/u/r', 'F:/repo.git']) assert.deepEqual(await auth.gitArguments(url, 'alice'), []);
    assert.equal(calls, 0);
    assert.deepEqual(await auth.gitArguments('https://github.com/u/r.git', ''), []);
    assert.equal(calls, 0);
    const args = await auth.gitArguments('https://github.com/u/r.git', 'alice');
    assert.ok(args.includes('credential.helper=') && args.includes('credential.helper=manager'));
    assert.ok(args.includes('credential.https://github.com.username=alice'));
    assert.ok(args.includes('credential.https://github.com.useHttpPath=false'));
    assert.ok(!JSON.stringify(args).includes('token'));
  });
  await test('Missing and malformed account names cannot silently use a different account', async () => {
    const auth = new GitHubAuth(async args => args.includes('--version') ? 'version' : 'alice\nWarning: ignored\n');
    await assert.rejects(() => auth.gitArguments('https://github.com/u/r', 'bob'));
    await assert.rejects(() => auth.gitArguments('https://github.com/u/r', 'alice\nconfig'));
    assert.deepEqual((await auth.inspect()).accounts, ['alice']);
  });
  await test('Cancellation propagates without trying the fallback manager or starting login', async () => {
    const abort = new AbortController(); let calls = 0;
    const auth = new GitHubAuth(async (_args, signal) => { calls++; abort.abort(); assert.equal(signal, abort.signal); throw Error('cancel'); });
    await assert.rejects(() => auth.login(abort.signal)); assert.equal(calls, 1);
    const early = new GitHubAuth(async () => { throw Error('must not run'); });
    await assert.rejects(() => early.inspect(abort.signal));
  });
  await test('Process execution hides windows, closes stdin, times out and suppresses OAuth diagnostics', async () => {
    const calls = []; let error = false;
    const Auth = load({ execFile(binary, args, options, done) {
      calls.push({ binary, args, options, ended: false }); const record = calls.at(-1);
      queueMicrotask(() => done(error ? Error('secret-code-and-callback-url') : null, args.includes('list') ? 'alice\n' : '', 'sensitive stderr'));
      return { stdin: { on() {}, end() { record.ended = true; } } };
    } });
    const auth = new Auth(); const signal = new AbortController().signal;
    await auth.login(signal);
    const login = calls.find(call => call.args.includes('login'));
    assert.equal(login.binary, 'git'); assert.equal(login.options.windowsHide, true);
    assert.equal(login.options.timeout, 300000); assert.equal(login.options.signal, signal);
    assert.equal(login.options.env.GCM_INTERACTIVE, 'Always'); assert.equal(login.ended, true);
    error = true;
    await assert.rejects(() => auth.login(signal), err => !err.message.includes('secret-code') && !err.message.includes('sensitive stderr'));
  });
  console.log(passed + ' GitHub authentication checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
