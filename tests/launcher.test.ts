import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
test('launcher allocates unique owned evidence sessions and preserves colliding sentinel files', async () => {
  const modulePath = pathToFileURL(resolve('scripts/runExtensionHost.mjs')).href;
  const launcher = (await import(modulePath)) as {
    createEvidenceDirectory(parent: string): string;
  };
  const parent = mkdtempSync(join(tmpdir(), 'devloom-evidence-test-'));
  const names = ['result.json', 'launcher-result.json', 'extension-host.log'];
  try {
    for (const name of names) writeFileSync(join(parent, name), `sentinel:${name}`, { flag: 'wx' });
    const first = launcher.createEvidenceDirectory(parent);
    const second = launcher.createEvidenceDirectory(parent);
    assert.notEqual(first, second);
    assert.equal(dirname(first), parent);
    assert.equal(dirname(second), parent);
    assert.deepEqual(readdirSync(first), []);
    assert.deepEqual(readdirSync(second), []);
    for (const name of names) {
      writeFileSync(join(first, name), `first:${name}`, { flag: 'wx' });
      writeFileSync(join(second, name), `second:${name}`, { flag: 'wx' });
      assert.equal(readFileSync(join(parent, name), 'utf8'), `sentinel:${name}`);
      assert.equal(readFileSync(join(first, name), 'utf8'), `first:${name}`);
      assert.throws(() => writeFileSync(join(first, name), 'collision', { flag: 'wx' }));
      assert.equal(readFileSync(join(second, name), 'utf8'), `second:${name}`);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
