import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  cpSync,
} from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildLocalArtifact } from '../scripts/localExtensionArtifact.mjs';
import {
  ensureLocalExtension,
  localEnvironment,
  nativeCLI,
  routingKeys,
} from '../scripts/localExtensionInstall.mjs';
import { developmentProfile } from '../scripts/developmentProfile.mjs';

function fixture(t) {
  const root = mkdtempSync('/private/tmp/dli-');
  for (const directory of [
    '.tools',
    'vendor/code-oss/out',
    'vendor/code-oss/.build/electron/Test.app/Contents/MacOS',
    'payload',
  ])
    mkdirSync(join(root, directory), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, 'LICENSE'), 'MIT fixture notice\n');
  writeFileSync(
    join(root, 'vendor/code-oss/product.json'),
    JSON.stringify({ nameLong: 'Test', nameShort: 'Test', applicationName: 'devloom' }),
  );
  writeFileSync(join(root, 'vendor/code-oss/out/cli.js'), '');
  writeFileSync(join(root, 'vendor/code-oss/.build/electron/Test.app/Contents/MacOS/Test'), '', {
    mode: 0o700,
  });
  writeFileSync(join(root, 'payload/main.js'), 'module.exports = "A";');
  const profile = developmentProfile(root, 'test');
  const payload = () => ({
    manifest: {
      name: 'fixture',
      publisher: 'devloom',
      version: '1.0.0',
      engines: { vscode: '^1.146.0' },
      main: './main.js',
    },
    files: { 'main.js': join(root, 'payload/main.js') },
  });
  const artifact = () => buildLocalArtifact(root, payload());
  const invocations = [];
  const cli = async (executable, args, options) => {
    const archive = args
      .find((arg) => arg.startsWith('--install-extension='))
      ?.split('=')
      .slice(1)
      .join('=');
    const destination = join(profile.extensions, 'devloom.fixture-1.0.0');
    if (archive) {
      const staging = join(root, `unzip-${invocations.length}`);
      mkdirSync(staging);
      execFileSync('/usr/bin/unzip', ['-q', archive, '-d', staging]);
      if (existsSync(destination)) rmSync(destination, { recursive: true });
      cpSync(join(staging, 'extension'), destination, { recursive: true });
      writeFileSync(
        join(profile.extensions, 'extensions.json'),
        JSON.stringify([
          {
            identifier: { id: 'devloom.fixture' },
            version: '1.0.0',
            location: { scheme: 'file', path: destination },
          },
        ]),
      );
    }
    const value = {
      executable,
      args,
      pid: process.pid,
      cwd: options.cwd,
      observedCwd: options.cwd,
      environment: Object.fromEntries(
        [...routingKeys, 'NODE_ENV', 'VSCODE_DEV'].map((key) => [key, options.env[key]]),
      ),
      code: 0,
      signal: null,
      output: args.includes('--list-extensions')
        ? 'devloom.fixture@1.0.0\n'
        : args.includes('--locate-extension=devloom.fixture')
          ? `${destination}\n`
          : '',
    };
    invocations.push(value);
    return value;
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, profile, payload, artifact, cli, invocations };
}
test('local env scrubs inherited editor routing without altering unrelated values', () => {
  const inherited = Object.fromEntries(routingKeys.map((key) => [key, 'foreign']));
  inherited.HOME = '/home/unchanged';
  const env = localEnvironment('/fixed', inherited);
  for (const key of routingKeys) assert.equal(env[key], undefined);
  assert.equal(env.HOME, inherited.HOME);
  assert.equal(inherited.ELECTRON_RUN_AS_NODE, 'foreign');
  assert.equal(env.DEVLOOM_APP_ROOT, '/fixed');
});
test('complete local archive preserves own notice and rejects unresolved runtime import', (t) => {
  const f = fixture(t);
  const a = f.artifact();
  const names = execFileSync('/usr/bin/unzip', ['-Z1', a.archive], { encoding: 'utf8' })
    .trim()
    .split('\n');
  assert.deepEqual(names.sort(), [
    'extension/LICENSE',
    'extension/main.js',
    'extension/package.json',
  ]);
  assert.equal(
    execFileSync('/usr/bin/unzip', ['-p', a.archive, 'extension/LICENSE'], { encoding: 'utf8' }),
    'MIT fixture notice\n',
  );
  writeFileSync(join(f.root, 'payload/main.js'), 'require("./missing");');
  assert.throws(() => f.artifact(), /import closure/);
  writeFileSync(join(f.root, 'payload/main.js'), 'require("foreign-package");');
  assert.throws(() => f.artifact(), /runtime dependency/);
});
test('fake native install binds exact executable/entry/cwd/env and reuses unchanged even live', async (t) => {
  const f = fixture(t);
  const artifact = f.artifact();
  const installed = await ensureLocalExtension(f.root, f.profile, artifact, {
    cli: f.cli,
    inactive: () => {},
  });
  assert.equal(installed.status, 'installed');
  assert.equal(installed.calls.length, 3);
  for (const call of installed.calls) {
    assert.equal(call.cwd, join(f.root, 'vendor/code-oss'));
    assert.equal(call.args[0], join(f.root, 'vendor/code-oss/out/cli.js'));
    assert.equal(call.args[1], '.');
    assert.ok(!call.args.some((arg) => arg.includes('inspect')));
  }
  const settings = readFileSync(f.profile.settings);
  const reused = await ensureLocalExtension(f.root, f.profile, artifact, {
    cli: () => assert.fail('No CLI on reuse'),
    inactive: () => assert.fail('Live reuse allowed'),
  });
  assert.equal(reused.status, 'reused');
  assert.deepEqual(readFileSync(f.profile.settings), settings);
});
test('trusted changed payload requires inactive profile and uses native force', async (t) => {
  const f = fixture(t);
  await ensureLocalExtension(f.root, f.profile, f.artifact(), { cli: f.cli, inactive: () => {} });
  writeFileSync(join(f.root, 'payload/main.js'), 'module.exports = "B";');
  const changed = f.artifact();
  const updated = await ensureLocalExtension(f.root, f.profile, changed, {
    cli: f.cli,
    inactive: () => {},
  });
  assert.equal(updated.status, 'updated');
  assert.ok(updated.calls[0].args.includes('--force'));
});
test('wrong cwd fails even when fake install/list/registry/payload succeeded', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    ensureLocalExtension(f.root, f.profile, f.artifact(), {
      inactive: () => {},
      cli: async (...args) => ({ ...(await f.cli(...args)), observedCwd: f.root }),
    }),
    /actual cwd/,
  );
  assert.ok(existsSync(join(f.profile.path, '.pending-devloom.fixture.json')));
  assert.ok(existsSync(join(f.profile.path, '.local-install-lock')));
});
test('unknown own-ID collision preserves files and installer failure preserves pending', async (t) => {
  const f = fixture(t);
  const path = join(f.profile.extensions, 'devloom.fixture-unknown');
  mkdirSync(path);
  writeFileSync(join(path, 'sentinel'), 'unchanged');
  await assert.rejects(
    ensureLocalExtension(f.root, f.profile, f.artifact(), {
      cli: () => assert.fail('collision CLI'),
    }),
    /collision/,
  );
  assert.equal(readFileSync(join(path, 'sentinel'), 'utf8'), 'unchanged');
  const second = fixture(t);
  await assert.rejects(
    ensureLocalExtension(second.root, second.profile, second.artifact(), {
      inactive: () => {},
      cli: async () => {
        throw new Error('synthetic native failure');
      },
    }),
    /synthetic/,
  );
  assert.ok(existsSync(join(second.profile.path, '.pending-devloom.fixture.json')));
});
test('exclusive lock refuses concurrent installation and never expires stale lock', async (t) => {
  const f = fixture(t);
  let release;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const first = ensureLocalExtension(f.root, f.profile, f.artifact(), {
    inactive: () => {},
    cli: async (...args) => {
      entered();
      await blocked;
      return f.cli(...args);
    },
  });
  await started;
  await assert.rejects(ensureLocalExtension(f.root, f.profile, f.artifact()), /locked/);
  release();
  await first;
  mkdirSync(join(f.profile.path, '.local-install-lock'));
  await assert.rejects(ensureLocalExtension(f.root, f.profile, f.artifact()), /locked/);
});
test('native bounded child timeout closes and reaps its own process', async () => {
  let failure;
  try {
    await nativeCLI(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 100,
    });
  } catch (error) {
    failure = error;
  }
  assert.match(failure.message, /timeout/);
  assert.ok(failure.result.pid > 1);
  assert.throws(() => process.kill(failure.result.pid, 0), { code: 'ESRCH' });
});

test('tampered receipt inventory and archive never reach native child', async (t) => {
  const f = fixture(t);
  const artifact = f.artifact();
  await ensureLocalExtension(f.root, f.profile, artifact, { cli: f.cli, inactive: () => {} });
  const path = join(f.profile.path, '.receipt-devloom.fixture.json');
  const receipt = JSON.parse(readFileSync(path, 'utf8'));
  receipt.artifact.inventory[0].sha256 = 'f'.repeat(64);
  writeFileSync(path, JSON.stringify(receipt));
  await assert.rejects(
    ensureLocalExtension(f.root, f.profile, artifact, {
      cli: () => assert.fail('tampered receipt reached child'),
    }),
    /digest/,
  );
  const other = fixture(t);
  const corrupted = other.artifact();
  writeFileSync(corrupted.archive, 'tampered archive');
  await assert.rejects(
    ensureLocalExtension(other.root, other.profile, corrupted, {
      inactive: () => {},
      cli: () => assert.fail('tampered archive reached child'),
    }),
    /archive changed/,
  );
  assert.ok(existsSync(join(other.profile.path, '.pending-devloom.fixture.json')));
});
test('exact native portable directory refuses before install mutation and preserves it', async (t) => {
  const f = fixture(t);
  const path = join(f.root, 'vendor/devloom-portable-data');
  mkdirSync(path);
  writeFileSync(join(path, 'sentinel'), 'preserved');
  await assert.rejects(
    ensureLocalExtension(f.root, f.profile, f.artifact(), {
      cli: () => assert.fail('portable child'),
    }),
    /portable/,
  );
  assert.equal(readFileSync(join(path, 'sentinel'), 'utf8'), 'preserved');
  assert.equal(existsSync(join(f.profile.path, '.local-install-lock')), false);
});

test('own ID hidden under an arbitrary directory remains an unknown collision', async (t) => {
  const f = fixture(t);
  const path = join(f.profile.extensions, 'unusual-directory');
  mkdirSync(path);
  writeFileSync(join(path, 'package.json'), JSON.stringify(f.payload().manifest));
  await assert.rejects(
    ensureLocalExtension(f.root, f.profile, f.artifact(), {
      cli: () => assert.fail('unknown own manifest reached native child'),
    }),
    /collision/,
  );
  assert.ok(existsSync(join(path, 'package.json')));
});

test('active pre-mutation refusal releases only this attempt lock and inactive retry succeeds', async (t) => {
  const f = fixture(t);
  await ensureLocalExtension(f.root, f.profile, f.artifact(), { cli: f.cli, inactive: () => {} });
  writeFileSync(join(f.root, 'payload/main.js'), 'module.exports = "retry B";');
  const changed = f.artifact();
  const previous = f.invocations.length;
  await assert.rejects(
    ensureLocalExtension(f.root, f.profile, changed, {
      cli: f.cli,
      inactive: () => {
        throw new Error('Profile is active');
      },
    }),
    /active/,
  );
  assert.equal(f.invocations.length, previous);
  assert.equal(existsSync(join(f.profile.path, '.pending-devloom.fixture.json')), false);
  assert.equal(existsSync(join(f.profile.path, '.local-install-lock')), false);
  assert.equal(
    (await ensureLocalExtension(f.root, f.profile, changed, { cli: f.cli, inactive: () => {} }))
      .status,
    'updated',
  );
});
test('tampered owner record prevents pre-mutation lock cleanup', async (t) => {
  const f = fixture(t);
  const path = join(f.profile.path, '.local-install-lock/owner.json');
  const changed = JSON.stringify({ owner: 'foreign-owner' });
  await assert.rejects(
    ensureLocalExtension(f.root, f.profile, f.artifact(), {
      cli: () => assert.fail('native child before inactivity check'),
      inactive: () => {
        writeFileSync(path, changed);
        throw new Error('Profile is active');
      },
    }),
    /ownership changed/,
  );
  assert.equal(readFileSync(path, 'utf8'), changed);
  assert.equal(existsSync(join(f.profile.path, '.pending-devloom.fixture.json')), false);
});
test('prior pending state and native-start failure retain lock and pending evidence', async (t) => {
  const f = fixture(t);
  const pending = join(f.profile.path, '.pending-devloom.fixture.json');
  writeFileSync(pending, 'existing pending evidence');
  await assert.rejects(
    ensureLocalExtension(f.root, f.profile, f.artifact(), {
      cli: () => assert.fail('prior pending reached child'),
    }),
    /Pending/,
  );
  assert.equal(readFileSync(pending, 'utf8'), 'existing pending evidence');
  assert.equal(existsSync(join(f.profile.path, '.local-install-lock')), true);
  const other = fixture(t);
  await assert.rejects(
    ensureLocalExtension(other.root, other.profile, other.artifact(), {
      inactive: () => {},
      cli: async () => {
        throw new Error('native-start failure');
      },
    }),
    /native-start/,
  );
  assert.equal(existsSync(join(other.profile.path, '.pending-devloom.fixture.json')), true);
  assert.equal(existsSync(join(other.profile.path, '.local-install-lock')), true);
});
