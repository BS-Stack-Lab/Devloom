import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createFiles, digest } from '../scripts/componentInventoryFiles.mjs';
import { evidenceSession } from '../scripts/componentInventory.mjs';
import {
  acquireInputs,
  mandatoryJson,
  sourceInputs,
  writeCatalog,
} from '../scripts/commandCatalog.mjs';
const repository = resolve(import.meta.dirname, '..');
const cli = resolve(repository, 'scripts/commandCatalog.mjs');
const temporary = (t) => {
  const path = fs.realpathSync(fs.mkdtempSync(resolve(tmpdir(), 'catalog-test-')));
  t.after(() => fs.rmSync(path, { recursive: true, force: true }));
  return path;
};
const run = (args, env = {}) =>
  spawnSync(process.execPath, [cli, ...args], {
    cwd: repository,
    env: { ...process.env, DEVLOOM_EVIDENCE_DIR: '', ...env },
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
test('CLI rejects arguments, missing/relative/repository evidence parents without leaking raw errors', (t) => {
  const path = temporary(t);
  for (const [args, parent, code] of [
    [['unexpected'], path, 'unsupported-cli-argument'],
    [[], undefined, 'evidence-parent-required'],
    [[], 'relative', 'evidence-parent-required'],
    [[], repository, 'output-inside-repository'],
  ]) {
    const result = run(args, parent === undefined ? {} : { DEVLOOM_EVIDENCE_DIR: parent });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error, code);
  }
});
test('evidence parent repository symlink aliases are refused before writing', (t) => {
  const path = temporary(t),
    alias = resolve(path, 'alias');
  fs.symlinkSync(repository, alias);
  const result = run([], { DEVLOOM_EVIDENCE_DIR: resolve(alias, 'new-catalog') });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error, 'output-inside-repository');
  assert.equal(fs.existsSync(resolve(repository, 'new-catalog')), false);
});
test('mandatory bytes refuse missing, oversized, unparseable, wrong-shape and changed hashes', (t) => {
  const path = temporary(t),
    target = resolve(path, 'input.json');
  assert.throws(() => mandatoryJson(createFiles(path), target), /source-provenance-failed/);
  for (const bytes of [
    Buffer.from('{'),
    Buffer.from('[]'),
    Buffer.from('{"a":1,"a":2}'),
    Buffer.alloc(8388609, 32),
  ]) {
    fs.writeFileSync(target, bytes);
    assert.throws(() => mandatoryJson(createFiles(path), target), /source-provenance-failed/);
  }
  fs.writeFileSync(target, '{"a":1}');
  assert.throws(
    () => mandatoryJson(createFiles(path), target, '0'.repeat(64)),
    /source-provenance-failed/,
  );
  assert.equal(mandatoryJson(createFiles(path), target, digest('{"a":1}')).value.a, 1);
});
test('bounded mandatory reads refuse symlink inputs and nonregular files', (t) => {
  const path = temporary(t),
    real = resolve(path, 'real.json'),
    alias = resolve(path, 'alias.json');
  fs.writeFileSync(real, '{}');
  fs.symlinkSync(real, alias);
  assert.throws(() => mandatoryJson(createFiles(path), alias), /source-provenance-failed/);
  assert.throws(() => mandatoryJson(createFiles(path), path), /source-provenance-failed/);
});
test('all six immutable source inputs are mandatory and provenance checked before collection', (t) => {
  const path = temporary(t);
  for (const source of sourceInputs) {
    const directory = resolve(path, `vendor/code-oss/extensions/${source.extension}`);
    fs.mkdirSync(directory, { recursive: true });
    for (const name of ['package.json', 'package.nls.json'])
      fs.copyFileSync(
        resolve(repository, `vendor/code-oss/extensions/${source.extension}/${name}`),
        resolve(directory, name),
      );
  }
  assert.equal(acquireInputs(createFiles(path), path).length, 3);
  for (const source of sourceInputs)
    for (const name of ['package.json', 'package.nls.json']) {
      const target = resolve(path, `vendor/code-oss/extensions/${source.extension}/${name}`),
        bytes = fs.readFileSync(target);
      fs.rmSync(target);
      assert.throws(() => acquireInputs(createFiles(path), path), /source-provenance-failed/);
      fs.writeFileSync(target, Buffer.concat([bytes, Buffer.from(' ')]));
      assert.throws(() => acquireInputs(createFiles(path), path), /source-provenance-failed/);
      fs.writeFileSync(target, bytes);
    }
});
test('exclusive private reports preserve previous files and digest ignores session metadata', (t) => {
  const parent = temporary(t),
    first = evidenceSession(parent, repository),
    second = evidenceSession(parent, repository);
  const content = {
    collectionCompleteness: 'complete',
    mappingCoverage: 'incomplete',
    runtimeVerification: 'not-assessed',
    p0MappingGate: 'not-passed',
    payload: { enum: ['z', 'a'] },
  };
  const a = writeCatalog(first, content),
    b = writeCatalog(second, content);
  assert.notEqual(a.path, b.path);
  assert.equal(a.contentDigest, b.contentDigest);
  assert.equal(fs.statSync(a.path).mode & 0o777, 0o600);
  assert.ok(first.split('/').at(-1).startsWith('component-inventory-'));
  const bytes = fs.readFileSync(a.path);
  assert.throws(() => writeCatalog(first, { ...content, changed: true }), { code: 'EEXIST' });
  assert.deepEqual(fs.readFileSync(a.path), bytes);
  const report = JSON.parse(bytes);
  assert.deepEqual(report.content.payload.enum, ['z', 'a']);
  assert.equal(a.contentDigest, digest(JSON.stringify(report.content)));
  assert.notEqual(
    writeCatalog(evidenceSession(parent, repository), { ...content, payload: { enum: ['a', 'z'] } })
      .contentDigest,
    a.contentDigest,
  );
});
