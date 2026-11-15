import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { collectCatalog, parseJson, stable } from '../scripts/commandCatalogCollect.mjs';
import { sourceInputs } from '../scripts/commandCatalog.mjs';
const fixture = () => [
  {
    extension: 'test',
    manifestSha256: 'a'.repeat(64),
    nlsSha256: 'b'.repeat(64),
    manifest: {
      contributes: {
        commands: [{ command: 'sample', title: '%title%', enablement: 'ready' }],
        configuration: [
          {
            properties: {
              'a/b~c': {
                type: 'string',
                enum: ['z', 'a'],
                default: 'z',
                description: '%description%',
              },
            },
          },
        ],
        submenus: [{ id: 'local', label: '%title%' }],
        menus: {
          'a/b': [
            { command: 'sample', alt: 'core.action', when: 'ready', group: 'one@2' },
            { submenu: 'local' },
          ],
        },
        authentication: [{ id: 'provider' }],
      },
    },
    nls: { title: 'Declared title', description: 'Declared description' },
    expected: { command: 1, setting: 1, submenu: 1, menu: 2 },
  },
];
const pinned = () =>
  sourceInputs.map((source) => ({
    ...source,
    manifest: JSON.parse(
      fs.readFileSync(
        new URL(`../vendor/code-oss/extensions/${source.extension}/package.json`, import.meta.url),
      ),
    ),
    nls: JSON.parse(
      fs.readFileSync(
        new URL(
          `../vendor/code-oss/extensions/${source.extension}/package.nls.json`,
          import.meta.url,
        ),
      ),
    ),
  }));
test('fixed manifests enumerate exact counts and every pointer round-trips to original payload', () => {
  const inputs = pinned(),
    collection = collectCatalog(inputs);
  assert.equal(collection.collectionCompleteness, 'complete');
  assert.deepEqual(
    ['command', 'setting', 'menu', 'submenu'].map(
      (kind) => collection.records.filter((record) => record.kind === kind).length,
    ),
    [192, 113, 454, 9],
  );
  for (const record of collection.records) {
    const original = inputs.find((input) => input.extension === record.extension).manifest;
    const node = record.pointer
      .slice(1)
      .split('/')
      .reduce((value, key) => value[key.replaceAll('~1', '/').replaceAll('~0', '~')], original);
    assert.deepEqual(record.payload, node);
    assert.equal(
      record.sourceSha256,
      sourceInputs.find((input) => input.extension === record.extension).manifestSha256,
    );
  }
  assert.equal(collection.deferred.find((item) => item.contribution === 'authentication').count, 2);
  assert.ok(collection.deferred.some((item) => item.contribution === 'markdown.previewStyles'));
});
test('ordered enum/menu/submenu payloads survive stable serialization and escaped pointers', () => {
  const collection = collectCatalog(fixture());
  assert.equal(collection.collectionCompleteness, 'complete');
  const setting = collection.records.find((record) => record.kind === 'setting');
  assert.equal(setting.pointer, '/contributes/configuration/0/properties/a~1b~0c');
  assert.deepEqual(stable(setting).payload.enum, ['z', 'a']);
  assert.deepEqual(
    stable(collection).records.map((record) => record.sourceOrdinal),
    [0, 1, 2, 3, 4],
  );
  assert.equal(setting.labels[0].value, 'Declared description');
  const menu = collection.records.find((record) => record.kind === 'menu');
  assert.equal(menu.location, 'a/b');
  assert.equal(menu.references[0].target, 'test:command:/contributes/commands/0');
  assert.equal(menu.references[1].kind, 'external/core');
  assert.equal(collection.records.filter((record) => record.kind === 'command').length, 1);
  assert.deepEqual(menu.payload, {
    command: 'sample',
    alt: 'core.action',
    when: 'ready',
    group: 'one@2',
  });
});
test('verified-byte malformed shapes, duplicate identities, unresolved submenu and count limits are incomplete extraction', () => {
  for (const mutate of [
    (input) => {
      input.manifest.contributes.commands = {};
    },
    (input) => {
      input.manifest.contributes.commands.push(input.manifest.contributes.commands[0]);
    },
    (input) => {
      input.manifest.contributes.configuration.push(input.manifest.contributes.configuration[0]);
    },
    (input) => {
      input.manifest.contributes.menus['a/b'][1].submenu = 'missing';
    },
    (input) => {
      input.manifest.contributes.menus['a/b'] = {};
    },
    (input) => {
      input.expected.command = 2;
    },
  ]) {
    const inputs = fixture();
    mutate(inputs[0]);
    const collection = collectCatalog(inputs);
    assert.equal(collection.collectionCompleteness, 'incomplete');
    assert.ok(collection.diagnostics.length);
  }
  const collection = collectCatalog(fixture(), { recordLimit: 1 });
  assert.equal(collection.records.length, 1);
  assert.equal(collection.collectionCompleteness, 'incomplete');
});
test('duplicate JSON keys and invalid JSON are refused, including escaped equivalent keys', () => {
  assert.throws(() => parseJson(Buffer.from('{"a":1,"\\u0061":2}')), /duplicate-json-key/);
  assert.throws(() => parseJson(Buffer.from('{"a":{"b":1,"b":2}}')), /duplicate-json-key/);
  assert.throws(() => parseJson(Buffer.from('{')));
  assert.deepEqual(parseJson(Buffer.from('{"a":{"b":1},"c":{"b":2}}')), {
    a: { b: 1 },
    c: { b: 2 },
  });
});
test('declaration IDs are unique across extensions while record keys remain distinct', () => {
  const first = fixture()[0],
    second = structuredClone(first);
  second.extension = 'another-extension';
  const collection = collectCatalog([first, second]);
  assert.equal(collection.collectionCompleteness, 'incomplete');
  assert.deepEqual(
    collection.diagnostics.map((item) => item.code),
    ['duplicate-command', 'duplicate-setting', 'duplicate-submenu'],
  );
  assert.ok(collection.diagnostics.every((item) => item.extension === second.extension));
  assert.equal(collection.records.length, 10);
  assert.equal(new Set(collection.records.map((record) => record.key)).size, 10);
  for (const kind of ['command', 'setting', 'submenu']) {
    assert.equal(collection.records.filter((record) => record.kind === kind).length, 2);
  }
});
