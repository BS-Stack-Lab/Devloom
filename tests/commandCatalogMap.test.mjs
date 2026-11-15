import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { collectCatalog, stable } from '../scripts/commandCatalogCollect.mjs';
import { mapCatalog, validateRequirements } from '../scripts/commandCatalogMap.mjs';
import { sourceInputs } from '../scripts/commandCatalog.mjs';
const snapshot = JSON.parse(
  fs.readFileSync(new URL('../scripts/catalog/requirements.json', import.meta.url)),
);
const mappings = JSON.parse(
  fs.readFileSync(new URL('../scripts/catalog/mappings.json', import.meta.url)),
);
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
const decision = (record, changes = {}) => ({
  target: record.key,
  sourceSha256: record.sourceSha256,
  disposition: 'mapped',
  requirementIds: ['REP-02'],
  links: [],
  reason: 'Exact init control relates to existing repository-init acceptance; no runtime claim.',
  followUpPhase: 'P1',
  ...changes,
});
const mapping = (records) => ({
  schemaVersion: 1,
  decisions: records.map((record) => decision(record)),
});
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
test('selected requirements preserve original 160 of 200 rows with RD40 excluded', () => {
  validateRequirements(snapshot);
  assert.equal(snapshot.originalTotal, 200);
  assert.equal(snapshot.excludedRDTotal, 40);
  assert.equal(snapshot.requirements.length, 160);
  assert.ok(
    snapshot.requirements.every((row) => row.status === 'planned' && !row.id.startsWith('RD-')),
  );
  assert.equal(snapshot.schema_version, 2);
  assert.equal(
    snapshot.originalSha256,
    '9e20992c98aa9b66a0b3b9dd4a4ab8c314e3dac47d5d41e2343f862956ffd27c',
  );
  assert.equal(snapshot.requirements[0].id, 'REP-01');
  assert.equal(snapshot.requirements[0].verification_id, 'QA-REP-01');
  assert.equal(snapshot.requirements[0].originPointer, '/requirements/0');
});
test('mapping expands exact acceptance, status and declared menu context with decision lineage', () => {
  const collection = collectCatalog(fixture()),
    decisions = mapping(collection.records);
  const command = collection.records.find((record) => record.kind === 'command');
  const menu = collection.records.find((record) => record.kind === 'menu');
  decisions.decisions.find((item) => item.target === menu.key).links = [command.key];
  decisions.decisions.find((item) => item.target === menu.key).requirementIds = [];
  const report = mapCatalog(collection, snapshot, decisions);
  assert.equal(report.p0MappingGate, 'pass');
  assert.equal(report.runtimeVerification, 'not-assessed');
  const expanded = report.records.find((item) => item.key === menu.key);
  assert.deepEqual(expanded.requirements, [
    snapshot.requirements.find((row) => row.id === 'REP-02'),
  ]);
  assert.deepEqual(expanded.decisionLineage, [{ target: command.key, disposition: 'mapped' }]);
  assert.ok(
    report.records
      .find((item) => item.key === command.key)
      .uiContexts.some((context) => context.pointer === menu.pointer),
  );
  assert.equal(report.requirements.find((row) => row.id === 'PR-01').sourceLinkState, 'unlinked');
});
test('unknown decision and missing NLS label block mapping while enumeration remains complete', () => {
  const inputs = fixture();
  delete inputs[0].nls.title;
  const collection = collectCatalog(inputs),
    report = mapCatalog(collection, snapshot, { schemaVersion: 1, decisions: [] });
  assert.equal(report.collectionCompleteness, 'complete');
  assert.equal(report.mappingCoverage, 'incomplete');
  assert.equal(report.p0MappingGate, 'not-passed');
  assert.equal(report.runtimeVerification, 'not-assessed');
  assert.ok(report.records.every((record) => record.decision.disposition === 'unmapped'));
  assert.ok(report.summary.unresolved.some((item) => item.unresolvedLabels.length));
  assert.ok(report.requirements.every((row) => row.status === 'planned'));
  const decisions = mapping(collection.records),
    stillMissingLabel = mapCatalog(collection, snapshot, decisions);
  assert.equal(stillMissingLabel.mappingCoverage, 'incomplete');
});
test('mapping rejects stale hashes/targets, duplicates, RD/unknown IDs, empty reasons and invalid lineage', () => {
  const collection = collectCatalog(fixture());
  for (const mutate of [
    (data) => data.decisions.push(data.decisions[0]),
    (data) => {
      data.decisions[0].target = 'stale';
    },
    (data) => {
      data.decisions[0].sourceSha256 = 'c'.repeat(64);
    },
    (data) => {
      data.decisions[0].requirementIds = ['RD-01'];
    },
    (data) => {
      data.decisions[0].requirementIds = ['UNKNOWN'];
    },
    (data) => {
      data.decisions[0].reason = '';
    },
    (data) => {
      data.decisions[0].disposition = 'unsupported';
    },
    (data) => {
      data.decisions[0].links = [collection.records[1].key];
    },
    (data) => {
      data.decisions[0].disposition = 'internal';
      data.decisions[0].requirementIds = [];
    },
  ]) {
    const data = mapping(collection.records);
    mutate(data);
    assert.throws(() => mapCatalog(collection, snapshot, data), /catalog-contract-invalid/);
  }
  for (const mutate of [
    (data) => {
      data.requirements[0].status = 'implemented';
    },
    (data) => {
      data.requirements[0].id = 'RD-01';
    },
    (data) => {
      data.requirements[1].originPointer = data.requirements[0].originPointer;
    },
    (data) => {
      data.originalSha256 = 'bad';
    },
  ]) {
    const data = structuredClone(snapshot);
    mutate(data);
    assert.throws(() => validateRequirements(data), /catalog-contract-invalid/);
  }
});
test('real semantic data keeps reviewed gaps explicit and deterministic', () => {
  const collection = collectCatalog(pinned()),
    report = mapCatalog(collection, snapshot, mappings);
  assert.equal(mappings.decisions.length, collection.records.length);
  assert.equal(report.collectionCompleteness, 'complete');
  assert.equal(report.mappingCoverage, 'incomplete');
  assert.equal(report.p0MappingGate, 'not-passed');
  assert.ok(report.summary.unresolved.length > 0);
  assert.equal(
    report.records.find((record) => record.id === 'git.init').requirements[0].id,
    'REP-02',
  );
  assert.equal(
    report.records.find((record) => record.id === 'git.diff.stageSelection').requirements[0].id,
    'CHG-05',
  );
  assert.equal(
    report.records.find((record) => record.id === 'github-enterprise.uris').requirements[0].id,
    'AUTH-03',
  );
  assert.equal(
    JSON.stringify(stable(report)),
    JSON.stringify(stable(mapCatalog(collectCatalog(pinned()), snapshot, mappings))),
  );
});
