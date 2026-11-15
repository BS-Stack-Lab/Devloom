import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  createFiles,
  digest,
  safeText,
  safeUrl,
  within,
} from '../scripts/componentInventoryFiles.mjs';
import { evidenceSession, writeInventory, canonical } from '../scripts/componentInventory.mjs';
const fixture = (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(resolve(tmpdir(), 'inventory-files-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};
const put = (root, path, bytes) => {
  fs.mkdirSync(resolve(root, path, '..'), { recursive: true });
  fs.writeFileSync(resolve(root, path), bytes);
};
test('bounded reads hash raw bytes and reject malformed component JSON', (t) => {
  const root = fixture(t);
  put(root, 'LICENSE', 'hello\r\n');
  put(root, 'package.json', '{');
  const files = createFiles(root);
  assert.equal(files.read(resolve(root, 'LICENSE'), 'license').sha256, digest('hello\r\n'));
  assert.equal(files.json(resolve(root, 'package.json')), null);
  assert.equal(files.diagnostics.at(-1).code, 'invalid-json');
  assert.equal(createFiles(root, { license: 1 }).read(resolve(root, 'LICENSE'), 'license'), null);
  assert.equal(createFiles(root, { total: 1 }).read(resolve(root, 'LICENSE'), 'license'), null);
});
test('directory entry and depth bounds are observed', (t) => {
  const root = fixture(t);
  put(root, 'a/b/c', 'x');
  const files = createFiles(root, { depth: 1 });
  files.walk(root, () => assert.fail());
  assert.equal(files.diagnostics[0].code, 'depth-limit');
  const tiny = createFiles(root, { entries: 0 });
  tiny.walk(root, () => assert.fail());
  assert.equal(tiny.diagnostics[0].code, 'entry-limit');
});
test('symlink escape, broken and cycle links never expose their targets', (t) => {
  const root = fixture(t),
    external = fixture(t);
  put(external, 'secret', 'secret-value');
  fs.symlinkSync(external, resolve(root, 'escape'));
  fs.symlinkSync('missing', resolve(root, 'broken'));
  fs.symlinkSync('.', resolve(root, 'cycle'));
  const files = createFiles(root);
  files.walk(root, () => assert.fail(), { followLinks: true });
  assert.equal(files.read(resolve(root, 'escape/secret')), null);
  assert(!JSON.stringify(files.diagnostics).includes(external));
  assert(!JSON.stringify(files.diagnostics).includes('secret-value'));
  assert(!within(root, `${root}-alias`));
});
test('license references remain package relative and declarations are not approvals', (t) => {
  const root = fixture(t);
  put(
    root,
    'package.json',
    JSON.stringify({ name: 'demo', version: '1.0', license: 'SEE LICENSE IN text/legal.txt' }),
  );
  put(root, 'text/legal.txt', 'legal');
  const files = createFiles(root),
    component = files.component(root, 'source');
  assert.equal(component.licenses.length, 1);
  assert.equal(component.runtimeLoaded, 'unknown');
  put(
    root,
    'package.json',
    JSON.stringify({ name: 'demo', version: '1', license: { type: 'MIT', url: 'secret' } }),
  );
  assert.equal(files.component(root, 'source').license, 'MIT');
  assert.equal(safeText('https://token@example.com'), 'unknown');
  assert.equal(safeUrl('https://user:secret@example.com/repo'), 'unknown');
  assert.equal(safeUrl('https://example.com/repo?token=secret'), 'unknown');
  assert.equal(safeUrl('https://example.com/repo'), 'https://example.com/repo');
});
test('external unique sessions preserve existing output and refuse repository aliases', (t) => {
  const root = fixture(t),
    parent = fixture(t);
  put(parent, 'sentinel', 'keep');
  assert.throws(() => evidenceSession(undefined, root));
  assert.throws(() => evidenceSession('relative', root));
  assert.throws(() => evidenceSession(resolve(root, 'new'), root));
  fs.symlinkSync(root, resolve(parent, 'alias'));
  assert.throws(() => evidenceSession(resolve(parent, 'alias/new'), root));
  const first = evidenceSession(parent, root),
    second = evidenceSession(parent, root);
  assert.notEqual(first, second);
  const content = {
    legalApproval: 'not-assessed',
    scanCompleteness: 'complete',
    licenseCoverage: 'partial',
    items: [{ a: 1 }, { a: 2 }],
  };
  const a = writeInventory(first, content),
    b = writeInventory(second, { ...content, items: [...content.items].reverse() });
  assert.equal(a.contentDigest, b.contentDigest);
  assert.throws(() => writeInventory(first, content));
  assert.equal(fs.readFileSync(resolve(parent, 'sentinel'), 'utf8'), 'keep');
  assert.deepEqual(canonical({ z: 1, a: 2 }), { a: 2, z: 1 });
  assert.equal(fs.statSync(a.path).mode & 0o777, 0o600);
});
test('complete collection with missing licenses remains partial, invalid manifest becomes incomplete', async (t) => {
  const { collectInventory } = await import('../scripts/componentInventoryCollectors.mjs');
  const root = fixture(t);
  for (const path of [
    'package.json',
    'upstream.lock.json',
    'product/devloom.json',
    'vendor/code-oss/package.json',
    'vendor/code-oss/product.json',
  ])
    put(root, path, JSON.stringify({ name: 'fixture', version: '1' }));
  for (const path of [
    'pnpm-lock.yaml',
    'LICENSE',
    'rust-toolchain.toml',
    'vendor/code-oss/pnpm-lock.yaml',
    'vendor/code-oss/.nvmrc',
    'vendor/code-oss/LICENSE.txt',
    'vendor/code-oss/ThirdPartyNotices.txt',
    'crates/devloom-sidecar/Cargo.toml',
    'crates/devloom-sidecar/Cargo.lock',
  ])
    put(root, path, 'fixture');
  put(root, 'vendor/code-oss/pnpm-workspace.yaml', 'packages:\n');
  for (const path of [
    'node_modules',
    'vendor/code-oss/node_modules',
    'vendor/code-oss/extensions',
    'vendor/code-oss/.build/builtInExtensions',
  ])
    fs.mkdirSync(resolve(root, path), { recursive: true });
  put(root, 'vendor/code-oss/.build/electron/version', '43.8.6');
  put(root, 'vendor/code-oss/.build/electron/electron', Buffer.from('cffaedfe', 'hex'));
  fs.chmodSync(resolve(root, 'vendor/code-oss/.build/electron/electron'), 0o755);
  const options = { spawn: () => Buffer.from(JSON.stringify({ packages: [] })) };
  const first = collectInventory(createFiles(root), {}, options);
  assert.equal(first.scanCompleteness, 'complete');
  assert.equal(first.licenseCoverage, 'partial');
  assert.equal(first.legalApproval, 'not-assessed');
  put(root, 'vendor/code-oss/extensions/broken/package.json', '{');
  const second = collectInventory(createFiles(root), {}, options);
  assert.equal(second.scanCompleteness, 'incomplete');
  assert.equal(second.licenseCoverage, 'unknown');
  assert.equal(second.legalApproval, 'not-assessed');
  put(root, 'vendor/code-oss/extensions/broken/package.json', 'null');
  assert.equal(collectInventory(createFiles(root), {}, options).scanCompleteness, 'incomplete');
});
