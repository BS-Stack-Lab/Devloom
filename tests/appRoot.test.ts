import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveApplicationHelper } from '../extensions/devloom-bootstrap/src/appRoot';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync('/private/tmp/dar-');
  const extension = join(root, 'extensions/devloom-bootstrap');
  const installed = join(root, 'installed');
  const helper = join(root, 'crates/devloom-sidecar/target/debug/devloom-sidecar');
  for (const path of [extension, installed, join(root, 'crates/devloom-sidecar/target/debug')])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'devloom', private: true }));
  const commit = '69047191fc427f2f92828279aae1d90d8eeda7ab';
  writeFileSync(join(root, 'upstream.lock.json'), JSON.stringify({ commit, version: '1.146.0' }));
  const manifest = {
    name: 'devloom-bootstrap',
    publisher: 'devloom',
    private: true,
    version: '0.0.1',
    engines: { vscode: '^1.146.0' },
  };
  writeFileSync(join(extension, 'package.json'), JSON.stringify(manifest));
  writeFileSync(
    join(installed, 'package.json'),
    JSON.stringify({
      ...manifest,
      devloomLocal: {
        schema: 1,
        sourceRoot: root,
        upstreamCommit: commit,
        helperRelative: 'crates/devloom-sidecar/target/debug/devloom-sidecar',
        sourceManifestSha256: createHash('sha256')
          .update(readFileSync(join(extension, 'package.json')))
          .digest('hex'),
      },
    }),
  );
  writeFileSync(helper, 'fixture executable never run', { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, extension, installed, helper };
}
test('installed resolver is Node-only, requires explicit root and binds provenance', (t) => {
  const f = fixture(t);
  assert.throws(() => resolveApplicationHelper(f.installed, 'production', {}), /required/);
  assert.equal(
    resolveApplicationHelper(f.installed, 'production', { DEVLOOM_APP_ROOT: f.root }),
    f.helper,
  );
  assert.throws(
    () => resolveApplicationHelper(f.installed, 'production', { DEVLOOM_APP_ROOT: '.' }),
    /explicit/,
  );
  writeFileSync(join(f.installed, 'package.json'), '{}');
  assert.throws(
    () => resolveApplicationHelper(f.installed, 'production', { DEVLOOM_APP_ROOT: f.root }),
    /provenance/,
  );
});
test('development/test fallback uses exact source extension parent, invalid explicit env never falls back', (t) => {
  const f = fixture(t);
  for (const mode of ['development', 'test'] as const) {
    assert.equal(resolveApplicationHelper(f.extension, mode, {}), f.helper);
    assert.throws(
      () => resolveApplicationHelper(f.extension, mode, { DEVLOOM_APP_ROOT: '' }),
      /explicit/,
    );
    assert.throws(() =>
      resolveApplicationHelper(f.extension, mode, { DEVLOOM_APP_ROOT: f.installed }),
    );
  }
});
test('missing, writable, nonexecutable and symlink helper fail without executing workspace alternative', (t) => {
  const f = fixture(t);
  const resolve = () =>
    resolveApplicationHelper(f.installed, 'production', { DEVLOOM_APP_ROOT: f.root });
  chmodSync(f.helper, 0o777);
  assert.throws(resolve, /unsafe/);
  chmodSync(f.helper, 0o600);
  assert.throws(resolve, /unsafe/);
  rmSync(f.helper);
  assert.throws(resolve);
  const tempting = join(f.root, 'workspace-helper');
  writeFileSync(tempting, 'never run', { mode: 0o700 });
  symlinkSync(tempting, f.helper);
  assert.throws(resolve, /unsafe/);
});
