import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  symlinkSync,
  unlinkSync,
  statSync,
  readdirSync,
  realpathSync,
  cpSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  developmentProfile,
  developmentLocation,
  selectDevelopmentProfile,
  developmentArguments,
  initialSettings,
} from '../scripts/developmentProfile.mjs';
import { publishOverlay } from '../scripts/upstream.mjs';

const profileModule = new URL('../scripts/developmentProfile.mjs', import.meta.url).href;
const upstreamModule = new URL('../scripts/upstream.mjs', import.meta.url).href;
function fixture(t) {
  const path = realpathSync(mkdtempSync('/tmp/dp-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function child(source, timeout = 10000) {
  return new Promise((done, reject) => {
    const instance = spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let failure;
    const timer = setTimeout(() => {
      failure = new Error(`Fixture child timed out after ${timeout}ms`);
      instance.kill('SIGKILL');
    }, timeout);
    instance.stdout.on('data', (data) => {
      stdout += data;
    });
    instance.stderr.on('data', (data) => {
      stderr += data;
    });
    instance.once('error', (error) => {
      failure = error;
    });
    instance.once('close', (code, signal) => {
      clearTimeout(timer);
      if (failure) {
        reject(Object.assign(failure, { pid: instance.pid, code, signal, stdout, stderr }));
      } else done({ code, stdout, stderr });
    });
  });
}

test('hung fixture child is killed and reaped before timeout rejection', async () => {
  await assert.rejects(
    child("process.stdout.write('ready'); setInterval(() => {}, 1000);", 500),
    (error) => {
      assert.match(error.message, /timed out after 500ms/);
      assert.equal(error.stdout, 'ready');
      assert.equal(error.signal, 'SIGKILL');
      assert.equal(error.code, null);
      assert.ok(Number.isSafeInteger(error.pid) && error.pid > 1);
      assert.throws(() => process.kill(error.pid, 0), { code: 'ESRCH' });
      return true;
    },
  );
});

test('selection has exact CLI, environment and default precedence', (t) => {
  const workspace = fixture(t);
  assert.deepEqual(selectDevelopmentProfile([], {}), { id: 'default', workspace: undefined });
  assert.equal(selectDevelopmentProfile([], { DEVLOOM_PROFILE: 'environment' }).id, 'environment');
  for (const args of [
    ['--dev-profile', 'a'],
    ['--', '--dev-profile=a'],
  ]) {
    assert.equal(selectDevelopmentProfile(args, { DEVLOOM_PROFILE: '' }).id, 'a');
  }
  assert.deepEqual(selectDevelopmentProfile(['--dev-profile=work', '.'], {}, workspace), {
    id: 'work',
    workspace,
  });
  assert.equal(selectDevelopmentProfile(['--dev-profile', 'x'.repeat(48)], {}).id.length, 48);
  for (const id of ['', 'X', '.', '../x', 'a/b', '한글', 'x'.repeat(49), '-x'])
    assert.throws(() => selectDevelopmentProfile(['--dev-profile', id], {}));
  assert.throws(() => selectDevelopmentProfile([], { DEVLOOM_PROFILE: '' }));
});

test('unknown, duplicate and native routing options fail before profile writes', (t) => {
  const root = fixture(t);
  for (const args of [
    ['--dev-profile'],
    ['--dev-profile=a', '--dev-profile=b'],
    ['--profile', 'x'],
    ['--profile-temp'],
    ['--user-data-dir=/tmp/x'],
    ['--extensions-dir=/tmp/x'],
    ['--extensionTestsPath=x'],
    ['--extensionDevelopmentPath=x'],
    ['-n'],
    ['--', '--'],
    [root, root],
    [join(root, 'missing')],
  ])
    assert.throws(() => selectDevelopmentProfile(args, {}, root));
  const file = join(root, 'file');
  writeFileSync(file, 'sentinel');
  assert.throws(() => selectDevelopmentProfile([file], {}));
  assert.deepEqual(readdirSync(root), ['file']);
});

test('exclusive first creation initializes fixed private roots and launch policy', (t) => {
  const root = fixture(t);
  const profile = developmentProfile(root, 'a');
  assert.equal(profile.created, true);
  assert.deepEqual(JSON.parse(readFileSync(profile.settings)), initialSettings);
  for (const path of [
    profile.path,
    profile.userData,
    profile.extensions,
    join(profile.userData, 'User'),
  ]) {
    assert.equal(statSync(path).mode & 0o077, 0);
    assert.equal(statSync(path).uid, process.getuid());
  }
  for (const path of [profile.settings, join(profile.path, '.devloom-owner.json')])
    assert.equal(statSync(path).mode & 0o077, 0);
  const args = developmentArguments(root, profile, root);
  assert.ok(args.includes(`--user-data-dir=${profile.userData}`));
  assert.ok(args.includes(`--extensions-dir=${profile.extensions}`));
  assert.ok(
    !args.some((arg) =>
      /--(new-window|reuse-window|extensionDevelopmentPath|extensionTestsPath|inspect|remote-debugging)/.test(
        arg,
      ),
    ),
  );
  assert.ok(args.includes('--disable-telemetry'));
  assert.equal(args.filter((value) => value.startsWith('--disable-extension=')).length, 4);
  assert.equal(args.at(-1), root);
});

test('reusing preserves JSONC, native bytes and mtimes; removed settings stay absent', (t) => {
  const root = fixture(t);
  const profile = developmentProfile(root, 'a');
  const jsonc = '{\n  // retained user preference\n  "telemetry.telemetryLevel": "all",\n}\n';
  writeFileSync(profile.settings, jsonc);
  const state = join(profile.userData, 'User', 'state.vscdb');
  const bytes = Buffer.from([0, 9, 255, 10]);
  writeFileSync(state, bytes);
  const before = statSync(profile.settings, { bigint: true }).mtimeNs;
  for (let index = 0; index < 3; index++)
    assert.equal(developmentProfile(root, 'a').created, false);
  assert.equal(readFileSync(profile.settings, 'utf8'), jsonc);
  assert.deepEqual(readFileSync(state), bytes);
  assert.equal(statSync(profile.settings, { bigint: true }).mtimeNs, before);
  unlinkSync(profile.settings);
  developmentProfile(root, 'a');
  assert.equal(readdirSync(join(profile.userData, 'User')).includes('settings.json'), false);
});

test('unknown and interrupted directories are preserved without adoption or repair', (t) => {
  for (const kind of ['root', 'profile']) {
    const root = fixture(t);
    developmentProfile(root, 'existing');
    const namespace = join(root, '.tools/dp');
    const unknown = kind === 'root' ? namespace : developmentLocation(root, 'unknown').path;
    if (kind === 'root') unlinkSync(join(namespace, '.devloom-owner.json'));
    else mkdirSync(unknown);
    writeFileSync(join(unknown, 'sentinel'), 'unchanged');
    assert.throws(() => developmentProfile(root, 'unknown'), /inspect|retry|ENOENT/);
    assert.equal(readFileSync(join(unknown, 'sentinel'), 'utf8'), 'unchanged');
    assert.equal(readdirSync(unknown).includes('.devloom-owner.json'), false);
  }
});

test('malformed, wrong-schema, wrong-root and oversized markers fail closed', (t) => {
  for (const mutate of [
    () => '{',
    (marker) => JSON.stringify({ ...marker, schema: 2 }),
    (marker) => JSON.stringify({ ...marker, root: '/foreign' }),
    (marker) => JSON.stringify({ ...marker, unexpected: true }),
    () => ' '.repeat(4097),
  ]) {
    const root = fixture(t);
    const profile = developmentProfile(root, 'a');
    const path = join(profile.path, '.devloom-owner.json');
    const value = mutate(JSON.parse(readFileSync(path)));
    writeFileSync(path, value);
    assert.throws(() => developmentProfile(root, 'a'));
    assert.equal(readFileSync(path, 'utf8'), value);
  }
});

test('every managed symlink boundary and writable directory is refused', (t) => {
  for (const relative of [
    '.tools',
    '.tools/dp',
    '.tools/dp/ca978112ca1bbdca',
    '.tools/dp/ca978112ca1bbdca/u',
    '.tools/dp/ca978112ca1bbdca/extensions',
    '.tools/dp/ca978112ca1bbdca/u/User',
    '.tools/dp/ca978112ca1bbdca/u/User/settings.json',
    '.tools/dp/ca978112ca1bbdca/.devloom-owner.json',
  ]) {
    const root = fixture(t);
    developmentProfile(root, 'a');
    const path = join(root, relative);
    const foreign = join(root, 'foreign');
    mkdirSync(foreign);
    writeFileSync(join(foreign, 'sentinel'), 'foreign');
    rmSync(path, { recursive: true });
    symlinkSync(foreign, path);
    assert.throws(() => developmentProfile(root, 'a'));
    assert.equal(readFileSync(join(foreign, 'sentinel'), 'utf8'), 'foreign');
  }
  for (const relative of [
    '.tools',
    '.tools/dp/ca978112ca1bbdca',
    '.tools/dp/ca978112ca1bbdca/extensions',
  ]) {
    const root = fixture(t);
    developmentProfile(root, 'a');
    chmodSync(join(root, relative), 0o770);
    assert.throws(() => developmentProfile(root, 'a'));
  }
  const root = fixture(t);
  const profile = developmentProfile(root, 'a');
  chmodSync(join(profile.path, '.devloom-owner.json'), 0o644);
  assert.throws(() => developmentProfile(root, 'a'));
});

test('two real creators initialize exactly once and retry only completed profiles', async (t) => {
  const root = fixture(t);
  developmentProfile(root, 'seed');
  const source = `import {developmentProfile} from ${JSON.stringify(profileModule)}; try { console.log(JSON.stringify(developmentProfile(${JSON.stringify(root)}, 'race'))); } catch { console.error('safe retry'); process.exitCode=1; }`;
  const results = await Promise.all([child(source), child(source)]);
  assert.equal(
    results.filter((item) => item.code === 0 && JSON.parse(item.stdout).created).length,
    1,
  );
  for (const item of results) assert.ok(item.code === 0 || item.stderr.includes('safe retry'));
  const profile = developmentProfile(root, 'race');
  assert.equal(profile.created, false);
  assert.deepEqual(JSON.parse(readFileSync(profile.settings)), initialSettings);
});

test('overlay publication is complete, private and idempotent under concurrent publishers', async (t) => {
  const root = fixture(t);
  mkdirSync(join(root, '.build'));
  const overlay = {
    nameShort: 'Devloom IDE',
    nameLong: 'Devloom IDE',
    applicationName: 'devloom',
    dataFolderName: '.devloom',
  };
  publishOverlay(root, overlay);
  const target = join(root, 'product.overrides.json');
  const before = statSync(target, { bigint: true });
  publishOverlay(root, overlay);
  assert.equal(statSync(target, { bigint: true }).mtimeNs, before.mtimeNs);
  assert.equal(statSync(target).mode & 0o077, 0);
  writeFileSync(target, '{"old":true}\n');
  const source = `import {publishOverlay} from ${JSON.stringify(upstreamModule)}; publishOverlay(${JSON.stringify(root)}, ${JSON.stringify(overlay)});`;
  const executions = [child(source), child(source)];
  for (let index = 0; index < 20; index++) {
    assert.doesNotThrow(() => JSON.parse(readFileSync(target)));
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.ok((await Promise.all(executions)).every((item) => item.code === 0));
  assert.deepEqual(JSON.parse(readFileSync(target)), overlay);
  assert.deepEqual(readdirSync(join(root, '.build')), []);
});

test('unsafe or failed staging preserves the previous overlay and unrelated files', (t) => {
  const root = fixture(t);
  const stage = join(root, '.build');
  mkdirSync(stage);
  const target = join(root, 'product.overrides.json');
  writeFileSync(target, '{"old":true}');
  writeFileSync(join(stage, 'unrelated'), 'keep');
  chmodSync(stage, 0o500);
  try {
    assert.throws(() => publishOverlay(root, { next: true }));
  } finally {
    chmodSync(stage, 0o700);
  }
  assert.equal(readFileSync(target, 'utf8'), '{"old":true}');
  assert.equal(readFileSync(join(stage, 'unrelated'), 'utf8'), 'keep');
  const foreign = join(root, 'foreign');
  mkdirSync(foreign);
  rmSync(stage, { recursive: true });
  symlinkSync(foreign, stage);
  assert.throws(() => publishOverlay(root, { next: true }));
  unlinkSync(stage);
  mkdirSync(stage);
  unlinkSync(target);
  symlinkSync(join(root, 'missing'), target);
  assert.throws(() => publishOverlay(root, { next: true }));
});

test('compact full-ID tokens preserve identity and never migrate the legacy root', (t) => {
  const root = fixture(t);
  mkdirSync(join(root, '.tools'), { mode: 0o700 });
  const legacy = join(root, '.tools/devloom-development-profiles');
  mkdirSync(legacy);
  writeFileSync(join(legacy, 'sentinel'), 'legacy bytes');
  const a = developmentProfile(root, 'a');
  const longest = developmentProfile(root, 'x'.repeat(48));
  assert.equal(a.token, 'ca978112ca1bbdca');
  assert.match(longest.token, /^[a-f0-9]{16}$/);
  assert.notEqual(a.token, longest.token);
  assert.equal(longest.marker.id, 'x'.repeat(48));
  assert.equal(longest.marker.userData, 'u');
  const marker = join(a.path, '.devloom-owner.json');
  const forged = JSON.stringify({ ...a.marker, id: 'different-full-id' });
  writeFileSync(marker, forged);
  assert.throws(() => developmentProfile(root, 'a'), /ownership|invalid/);
  assert.equal(readFileSync(marker, 'utf8'), forged);
  assert.equal(readFileSync(join(legacy, 'sentinel'), 'utf8'), 'legacy bytes');
});

test('both pinned IPC byte budgets are checked before all profile writes', (t) => {
  const parent = fixture(t);
  const sized = (bytes, multibyte = false) => {
    const prefix = Buffer.byteLength(parent, 'utf8') + 1;
    const name = multibyte ? `é${'x'.repeat(bytes - prefix - 2)}` : 'x'.repeat(bytes - prefix);
    const path = join(parent, name);
    mkdirSync(path);
    assert.equal(Buffer.byteLength(path, 'utf8'), bytes);
    return path;
  };
  const allowed = sized(56);
  const location = developmentLocation(allowed, 'x'.repeat(48));
  assert.deepEqual(
    location.ipc.map(({ bytes }) => bytes),
    [100, 102],
  );
  assert.equal(readdirSync(allowed).length, 0);
  developmentProfile(allowed, 'a');
  for (const root of [sized(57), sized(57, true)]) {
    const overlay = join(root, 'product.overrides.json');
    writeFileSync(overlay, 'untouched overlay');
    assert.throws(() => developmentLocation(root, 'a'), /103 UTF-8 bytes/);
    assert.throws(() => developmentProfile(root, 'a'), /shorter checkout/);
    assert.deepEqual(readdirSync(root), ['product.overrides.json']);
    assert.equal(readFileSync(overlay, 'utf8'), 'untouched overlay');
    const candidate = join(root, '.tools/dp/ca978112ca1bbdca/u/1.14-shared.sock');
    if (root.includes('é')) {
      assert.ok(candidate.length < 103);
      assert.ok(Buffer.byteLength(candidate, 'utf8') >= 103);
    }
  }
});

test('actual start dispatch rejects oversized roots before prepare or spawn', async (t) => {
  const parent = fixture(t);
  const root = join(parent, 'z'.repeat(57 - Buffer.byteLength(parent, 'utf8') - 1));
  mkdirSync(root);
  mkdirSync(join(root, 'scripts'));
  cpSync(new URL('../scripts/devloom.mjs', import.meta.url), join(root, 'scripts/devloom.mjs'));
  cpSync(
    new URL('../scripts/developmentProfile.mjs', import.meta.url),
    join(root, 'scripts/developmentProfile.mjs'),
  );
  writeFileSync(join(root, 'upstream.lock.json'), JSON.stringify({ version: '1.146.0' }));
  const overlay = join(root, 'product.overrides.json');
  writeFileSync(overlay, 'original overlay');
  writeFileSync(
    join(root, 'scripts/upstream.mjs'),
    `
    import {writeFileSync} from 'node:fs';
    export const root=${JSON.stringify(root)};
    export const upstream=root;
    export const prepare=()=>writeFileSync(root+'/product.overrides.json','changed');
    export const check=()=>{};
    export const run=()=>writeFileSync(root+'/spawn-called','yes');
  `,
  );
  const file = join(root, 'scripts/devloom.mjs');
  const outcome = await child(
    `process.argv=[process.execPath,${JSON.stringify(file)},'start']; await import(${JSON.stringify(file)});`,
  );
  assert.equal(outcome.code, 1);
  assert.match(outcome.stderr, /103 UTF-8 bytes/);
  assert.equal(readFileSync(overlay, 'utf8'), 'original overlay');
  assert.equal(readdirSync(root).includes('.tools'), false);
  assert.equal(readdirSync(root).includes('spawn-called'), false);
});
