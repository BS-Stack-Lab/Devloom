import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, loadEvidence, boundedFile } from '../scripts/p1CoverageEvidence.mjs';
const baseCases = [
  'normal',
  'concurrency',
  'linked-worktree',
  'untrusted',
  'missing-git',
  'unsupported-git',
  'worker-crash',
  'main-crash',
];
const parent = process.env.DEVLOOM_EVIDENCE_DIR;
function fixture(producer = 'local-git-v1') {
  assert.ok(parent, 'Set external DEVLOOM_EVIDENCE_DIR');
  const directory = mkdtempSync(join(parent, 'admission-unit-')),
    sessionRoot = join(directory, 'session');
  mkdirSync(sessionRoot, { mode: 0o700 });
  const nonce = '1'.repeat(32),
    sessionId = randomUUID(),
    source = {
      root: '/synthetic/source',
      baseCommit: 'a'.repeat(40),
      headCommit: 'b'.repeat(40),
      files: {},
      nativeWorkingFiles: {},
    };
  const sourceDigest = digest(JSON.stringify(source));
  const entry = {
    id: 'entry',
    producer,
    executionRelation: 'executed',
    executedBy: 'unit-actor',
    command: 'synthetic producer (admission test only)',
    cwd: source.root,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    exitCode: 0,
    sessionRoot,
    nonce,
    sessionId,
    sourceDigest,
    caseIds: ['p1-changes'],
    artifacts: [],
  };
  const add = (id, value, kind = 'json', relativePath) => {
    const path = join(sessionRoot, relativePath ?? id + '.' + (kind === 'json' ? 'json' : 'log')),
      raw = kind === 'json' ? Buffer.from(JSON.stringify(value)) : Buffer.from(value);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, raw, { flag: 'wx', mode: 0o600 });
    entry.artifacts.push({ id, path, sha256: digest(raw), bytes: raw.length, kind });
    return id;
  };
  const run = {
    status: 'pass',
    selected: ['p1-changes'],
    completed: ['p1-changes'],
    baseScenarios: [...baseCases],
    fullSuite: false,
    fullBaseSuite: false,
    targetedP1Complete: false,
    nonce,
    sessionId,
    sourceDigest,
    source,
  };
  const host = {
    code: 0,
    signal: null,
    status: 'pass',
    pid: 11,
    firstError: null,
    timedOut: false,
    finalized: true,
    finalization: {
      listenersDisposed: true,
      streamsClosed: true,
      timerCleared: true,
      logClosed: true,
    },
    cleanup: { confirmedClosed: true, leftovers: [] },
    launchRecord: { pid: 11, nonce, canonicalSourceRoot: source.root },
    result: {
      pid: 12,
      role: 'p1-changes',
      status: 'pass',
      sourceDigest,
      nonce,
      sessionId,
      assertions: [],
    },
  };
  if (producer === 'local-git-v1') {
    add('run', run);
    add('launcher', host, 'json', 'p1-changes/profile/launcher-result.json');
  }
  if (producer === 'commit-state-v1')
    add('run', {
      status: 'pass',
      completed: ['case'],
      nonce,
      session: sessionId,
      cleanup: { forced: false, leftovers: [] },
      observations: [],
    });
  if (producer === 'git-transports-v1')
    add('run', { status: 'pass', completed: Array.from({ length: 29 }, (_, i) => i), cases: [] });
  if (producer === 'node-test-v1') {
    const tap = 'TAP version 13\n# fail 0\n';
    add('tap', tap, 'log');
    add('manifest', {
      status: 'pass',
      exit_code: 0,
      command: entry.command,
      repo_root: source.root,
      code_digest: 'c'.repeat(64),
      log_sha256: digest(tap),
    });
  }
  const index = {
    schemaVersion: 1,
    indexId: randomUUID(),
    owner: { role: 'qa', agentId: 'unit-actor', slot: 1 },
    createdAt: new Date().toISOString(),
    source,
    entries: [entry],
    clauseEvidence: [],
  };
  const path = join(directory, 'index.json');
  const rewrite = (id, value) => {
    const artifact = entry.artifacts.find((a) => a.id === id);
    const raw = Buffer.from(JSON.stringify(value));
    writeFileSync(artifact.path, raw);
    Object.assign(artifact, { sha256: digest(raw), bytes: raw.length });
  };
  const save = () => writeFileSync(path, JSON.stringify(index), { mode: 0o600 });
  save();
  return {
    directory,
    sessionRoot,
    nonce,
    sessionId,
    source,
    entry,
    index,
    path,
    save,
    rewrite,
    add,
    run,
    host,
  };
}
function use(fn, producer) {
  const f = fixture(producer);
  try {
    return fn(f);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
}
const clauses = [{ id: 'CHG-04.1' }];
test('synthetic source-bound empty evidence remains an honest gap', () =>
  use((f) => {
    const value = loadEvidence(f.path, f.source, clauses);
    assert.equal(value.evidence.size, 0);
    assert.match(value.indexDigest, /^[a-f0-9]{64}$/);
  }));
test('every supported producer validates its actual narrow envelope without granting blanket acceptance', () => {
  for (const producer of ['commit-state-v1', 'git-transports-v1', 'node-test-v1'])
    use((f) => {
      assert.equal(loadEvidence(f.path, f.source, clauses).evidence.size, 0);
    }, producer);
});
for (const [name, mutate] of Object.entries({
  stale: (f) => (f.index.source.headCommit = 'd'.repeat(40)),
  foreign: (f) => (f.entry.executedBy = 'other'),
  unknownProducer: (f) => (f.entry.producer = 'arbitrary-import'),
  missingArtifact: (f) => (f.entry.artifacts[0].path = join(f.sessionRoot, 'missing.json')),
  truncated: (f) => writeFileSync(f.entry.artifacts[0].path, '{'),
  wrongHash: (f) => (f.entry.artifacts[0].sha256 = 'e'.repeat(64)),
  wrongSize: (f) => f.entry.artifacts[0].bytes++,
  duplicateEntries: (f) => f.index.entries.push(f.entry),
  duplicateArtifacts: (f) => f.entry.artifacts.push(f.entry.artifacts[0]),
  escape: (f) => (f.entry.artifacts[0].path = join(f.sessionRoot, '..', 'index.json')),
  rootLeaf: (f) => (f.entry.artifacts[0].path = f.sessionRoot),
  unsafeMode: (f) => chmodSync(f.entry.artifacts[0].path, 0o622),
  unknownClause: (f) => f.index.clauseEvidence.push({ clauseId: 'UNKNOWN' }),
  unsupportedStatusOnly: (f) => {
    const path = f.entry.artifacts[0].path;
    writeFileSync(path, JSON.stringify({ status: 'pass' }));
    const raw = readFileSync(path);
    f.entry.artifacts[0].bytes = raw.length;
    f.entry.artifacts[0].sha256 = digest(raw);
  },
  symlink: (f) => {
    const target = f.entry.artifacts[0].path;
    const link = join(f.sessionRoot, 'link');
    symlinkSync(target, link);
    f.entry.artifacts[0].path = link;
  },
  wrongSourceDigest: (f) => (f.entry.sourceDigest = 'e'.repeat(64)),
  badNonce: (f) => (f.entry.nonce = 'wrong'),
  unknownCase: (f) =>
    f.index.clauseEvidence.push({
      clauseId: 'CHG-04.1',
      entryId: 'entry',
      caseId: 'unknown',
      assertionIds: ['changes.folder'],
      artifactIds: ['run'],
      kind: 'native-api',
    }),
}))
  test('admission rejects ' + name, () =>
    use((f) => {
      mutate(f);
      f.save();
      const actualSource =
        name === 'stale' ? { ...f.source, headCommit: 'b'.repeat(40) } : f.source;
      assert.throws(() => loadEvidence(f.path, actualSource, clauses));
    }),
  );
test('duplicate JSON keys and oversized files reject before interpretation', () =>
  use((f) => {
    writeFileSync(f.path, '{"schemaVersion":1,"schemaVersion":1}');
    assert.throws(() => loadEvidence(f.path, f.source, clauses));
    writeFileSync(f.path, ' '.repeat(1024 * 1024 + 1));
    assert.throws(() => loadEvidence(f.path, f.source, clauses));
  }));
test('bounded descriptor reads accept owner-writable 0600 leaves and reject source root output', () =>
  use((f) => {
    assert.ok(boundedFile(f.entry.artifacts[0].path, f.sessionRoot).length);
    assert.throws(() => boundedFile(f.sessionRoot, dirname(f.sessionRoot)));
  }));
for (const producer of ['commit-state-v1', 'git-transports-v1', 'node-test-v1'])
  test(producer + ' rejects missing raw producer relation', () =>
    use((f) => {
      const artifact = f.entry.artifacts.find((a) => a.kind === 'json');
      writeFileSync(artifact.path, '{"status":"pass"}');
      const raw = readFileSync(artifact.path);
      Object.assign(artifact, { sha256: digest(raw), bytes: raw.length });
      f.save();
      assert.throws(() => loadEvidence(f.path, f.source, clauses));
    }, producer),
  );

function nativeFolder(f) {
  const beforeId = f.add('folder-before', {
    nonce: f.nonce,
    sessionId: f.sessionId,
    sourceDigest: f.entry.sourceDigest,
    value: {
      index: 'index bytes',
      disk: {
        'folder/one.txt': 'changed',
        'folder/nested/two.txt': 'nested',
        'sibling.txt': 'excluded',
      },
    },
  });
  const disk = {
    'folder/one.txt': 'changed',
    'folder/nested/two.txt': 'nested',
    'sibling.txt': 'excluded',
  };
  const afterId = f.add('folder-after', {
    nonce: f.nonce,
    sessionId: f.sessionId,
    sourceDigest: f.entry.sourceDigest,
    value: { index: 'index bytes', disk, stagedPaths: ['folder/nested/two.txt', 'folder/one.txt'] },
  });
  f.host.result.assertions = [
    {
      id: 'changes.folder',
      caseId: 'p1-changes',
      operation: 'add/revert',
      invocationKind: 'native-api',
      rootUri: 'file:///synthetic/fixture',
      beforeArtifactId: beforeId,
      afterArtifactId: afterId,
      expected: disk,
      actual: disk,
      observations: { oracle: 'synthetic typed independent oracle (admission test only)' },
    },
  ];
  const artifact = f.entry.artifacts.find((a) => a.id === 'launcher');
  writeFileSync(artifact.path, JSON.stringify(f.host));
  const bytes = readFileSync(artifact.path);
  Object.assign(artifact, { sha256: digest(bytes), bytes: bytes.length });
  f.index.clauseEvidence = [
    {
      clauseId: 'CHG-04.2',
      entryId: 'entry',
      caseId: 'p1-changes',
      assertionIds: ['changes.folder'],
      artifactIds: ['folder-before', 'folder-after', 'launcher', 'run'],
      kind: 'native-api',
    },
  ];
  f.save();
}
test('typed synthetic native admission binds before/after artifact records to exact compatible clause', () =>
  use((f) => {
    nativeFolder(f);
    assert.equal(
      loadEvidence(f.path, f.source, [{ id: 'CHG-04.2' }]).evidence.get('CHG-04.2').supported,
      true,
    );
    f.index.clauseEvidence[0].clauseId = 'CHG-04.1';
    f.save();
    assert.equal(
      loadEvidence(f.path, f.source, [{ id: 'CHG-04.1' }]).evidence.get('CHG-04.1').supported,
      false,
    );
  }));
test('forged equality without raw native oracle cannot support a clause', () =>
  use((f) => {
    nativeFolder(f);
    const artifact = f.entry.artifacts.find((a) => a.id === 'folder-after');
    const value = JSON.parse(readFileSync(artifact.path));
    value.value.stagedPaths = ['sibling.txt'];
    writeFileSync(artifact.path, JSON.stringify(value));
    const raw = readFileSync(artifact.path);
    Object.assign(artifact, { sha256: digest(raw), bytes: raw.length });
    f.save();
    assert.equal(
      loadEvidence(f.path, f.source, [{ id: 'CHG-04.2' }]).evidence.get('CHG-04.2').supported,
      false,
    );
  }));

const folderClauses = [{ id: 'CHG-04.2' }];
const folderSupported = (f) =>
  loadEvidence(f.path, f.source, folderClauses).evidence.get('CHG-04.2').supported;
function selectCases(f, selected, hostCases = selected) {
  f.run.selected = [...selected];
  f.run.completed = [...selected];
  f.run.fullSuite = selected.length === 8 && baseCases.every((name) => selected.includes(name));
  f.run.fullBaseSuite = baseCases.every((name) => selected.includes(name));
  f.run.targetedP1Complete = ['p1-changes', 'p1-sync'].every((name) => selected.includes(name));
  f.entry.caseIds = [...selected];
  if (!hostCases.includes('p1-changes'))
    f.entry.artifacts = f.entry.artifacts.filter((a) => a.id !== 'launcher');
  for (const scenario of hostCases.filter((name) => name !== 'p1-changes')) {
    const host = structuredClone(f.host);
    host.result.role = scenario;
    host.result.assertions = [];
    f.add('launcher-' + scenario, host, 'json', scenario + '/profile/launcher-result.json');
  }
  f.rewrite('run', f.run);
  f.save();
}
for (const key of ['selected', 'completed']) {
  for (const [name, value] of Object.entries({
    missing: undefined,
    null: null,
    scalar: 1,
    string: 'p1-changes',
    object: {},
    empty: [],
    whitespace: [' '],
    emptyName: [''],
    nonstring: [1],
    duplicate: ['p1-changes', 'p1-changes'],
    unknown: ['other'],
    mixed: ['p1-changes', 'other'],
    oversized: Array(11).fill('normal'),
    wrongKnown: ['p1-sync'],
  }))
    test('current producer rejects ' + key + ' ' + name + ' after artifact rehash', () =>
      use((f) => {
        nativeFolder(f);
        assert.equal(folderSupported(f), true);
        f.run[key] = value;
        f.rewrite('run', f.run);
        f.save();
        assert.throws(() => folderSupported(f), { message: 'PRODUCER_INCOMPLETE' });
      }),
    );
}
for (const [name, mutate, error] of [
  [
    'both empty',
    (f) => {
      f.run.selected = [];
      f.run.completed = [];
    },
    'PRODUCER_INCOMPLETE',
  ],
  [
    'both unknown',
    (f) => {
      f.run.selected = ['other'];
      f.run.completed = ['other'];
    },
    'PRODUCER_INCOMPLETE',
  ],
  [
    'both wrong known',
    (f) => {
      f.run.selected = ['p1-sync'];
      f.run.completed = ['p1-sync'];
    },
    'INVALID_CASES',
  ],
  [
    'entry empty',
    (f) => {
      f.entry.caseIds = [];
    },
    'INVALID_CASES',
  ],
  [
    'entry omitted',
    (f) => {
      delete f.entry.caseIds;
    },
    'INVALID_SESSION',
  ],
  [
    'entry duplicate',
    (f) => {
      f.entry.caseIds.push('p1-changes');
    },
    'INVALID_SESSION',
  ],
  [
    'entry unknown',
    (f) => {
      f.entry.caseIds = ['other'];
    },
    'INVALID_CASES',
  ],
  [
    'entry extra',
    (f) => {
      f.entry.caseIds.push('p1-sync');
    },
    'INVALID_CASES',
  ],
  [
    'entry wrong known',
    (f) => {
      f.entry.caseIds = ['p1-sync'];
    },
    'INVALID_CASES',
  ],
  [
    'role mismatch',
    (f) => {
      f.host.result.role = 'p1-sync';
    },
    'INVALID_LAUNCHER_CASE',
  ],
  [
    'assertion membership',
    (f) => {
      f.host.result.assertions[0].caseId = 'p1-sync';
    },
    'INVALID_ASSERTION_CASE',
  ],
  [
    'unknown assertion membership',
    (f) => {
      f.host.result.assertions[0].id = 'unknown';
      f.host.result.assertions[0].caseId = 'p1-sync';
    },
    'INVALID_ASSERTION_CASE',
  ],
  [
    'proof unknown case',
    (f) => {
      f.index.clauseEvidence[0].caseId = 'other';
    },
    'INVALID_POINTER',
  ],
])
  test('rehashing preserves intended rejection for ' + name, () =>
    use((f) => {
      nativeFolder(f);
      assert.equal(folderSupported(f), true);
      mutate(f);
      f.rewrite('run', f.run);
      f.rewrite('launcher', f.host);
      f.save();
      assert.throws(() => folderSupported(f), { message: error });
    }),
  );
for (const [name, mutate] of [
  [
    'wrong scenario',
    (f) => {
      const artifact = f.entry.artifacts.find((a) => a.id === 'launcher');
      const path = join(f.sessionRoot, 'p1-sync/profile/launcher-result.json');
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, readFileSync(artifact.path), { mode: 0o600 });
      artifact.path = path;
    },
  ],
  [
    'artifact id is not scenario proof',
    (f) => {
      const artifact = f.entry.artifacts.find((a) => a.id === 'launcher');
      const path = join(f.sessionRoot, 'p1-changes.json');
      writeFileSync(path, readFileSync(artifact.path), { mode: 0o600 });
      artifact.path = path;
    },
  ],
])
  test('launcher path rejects ' + name, () =>
    use((f) => {
      nativeFolder(f);
      assert.equal(folderSupported(f), true);
      mutate(f);
      f.save();
      assert.throws(() => folderSupported(f), { message: 'INVALID_LAUNCHER_CASE' });
    }),
  );
for (const key of ['fullSuite', 'fullBaseSuite', 'targetedP1Complete'])
  for (const value of [true, undefined, null, 0, 'false'])
    test('subset rejects inconsistent ' + key + '=' + value, () =>
      use((f) => {
        nativeFolder(f);
        assert.equal(folderSupported(f), true);
        f.run[key] = value;
        f.rewrite('run', f.run);
        f.save();
        assert.throws(() => folderSupported(f), { message: 'INVALID_SUITE_FLAGS' });
      }),
    );
for (const value of [
  undefined,
  [],
  baseCases.slice(1),
  [...baseCases, 'p1-changes'],
  [...baseCases.slice(1), 'normal', 'normal'],
])
  test('base scenario inventory must remain exactly original eight ' + JSON.stringify(value), () =>
    use((f) => {
      nativeFolder(f);
      assert.equal(folderSupported(f), true);
      f.run.baseScenarios = value;
      f.rewrite('run', f.run);
      f.save();
      assert.throws(() => folderSupported(f), { message: 'INVALID_SUITE_FLAGS' });
    }),
  );
test('phantom selected P1 case requires an actual launcher', () =>
  use((f) => {
    nativeFolder(f);
    assert.equal(folderSupported(f), true);
    selectCases(f, ['p1-changes', 'p1-sync'], ['p1-changes']);
    assert.throws(() => folderSupported(f), { message: 'MISSING_CASE_LAUNCHER' });
  }));
test('producer completion order must match selection order', () =>
  use((f) => {
    nativeFolder(f);
    selectCases(f, ['p1-changes', 'p1-sync']);
    assert.equal(folderSupported(f), true);
    f.run.completed.reverse();
    f.rewrite('run', f.run);
    f.save();
    assert.throws(() => folderSupported(f), { message: 'PRODUCER_INCOMPLETE' });
  }));
for (const selected of [
  ['p1-changes'],
  ['p1-sync', 'p1-changes'],
  [...baseCases],
  [...baseCases, 'p1-changes'],
  [...baseCases, 'p1-changes', 'p1-sync'].reverse(),
])
  test('exact suite flags accept legal selected set ' + selected.join(','), () =>
    use((f) => {
      selectCases(f, selected);
      f.entry.caseIds.reverse();
      f.run.baseScenarios.reverse();
      f.rewrite('run', f.run);
      f.save();
      assert.equal(loadEvidence(f.path, f.source, clauses).evidence.size, 0);
      for (const key of ['fullSuite', 'fullBaseSuite', 'targetedP1Complete']) {
        const original = f.run[key];
        f.run[key] = !original;
        f.rewrite('run', f.run);
        f.save();
        assert.throws(() => loadEvidence(f.path, f.source, clauses), {
          message: 'INVALID_SUITE_FLAGS',
        });
        f.run[key] = original;
      }
    }),
  );
test('reordered selections and multiple hosts preserve typed native support', () =>
  use((f) => {
    nativeFolder(f);
    selectCases(f, ['p1-sync', 'concurrency', 'p1-changes']);
    f.entry.caseIds.reverse();
    const host = structuredClone(f.host);
    host.result.role = 'concurrency';
    host.result.assertions = [];
    f.add('concurrency-b', host, 'json', 'concurrency/b/launcher-result.json');
    f.save();
    assert.equal(folderSupported(f), true);
    f.index.clauseEvidence[0].caseId = 'p1-sync';
    f.save();
    assert.equal(folderSupported(f), false);
  }));
test('unknown native assertion identifiers cannot grant support', () =>
  use((f) => {
    nativeFolder(f);
    assert.equal(folderSupported(f), true);
    for (const id of ['unknown', 'constructor', '__proto__']) {
      f.host.result.assertions[0].id = id;
      f.index.clauseEvidence[0].assertionIds = [id];
      f.rewrite('launcher', f.host);
      f.save();
      assert.equal(folderSupported(f), false);
    }
  }));
test('current p1-sync role and typed abort oracle support the matching clause', () =>
  use((f) => {
    selectCases(f, ['p1-sync']);
    const record = {
      nonce: f.nonce,
      sessionId: f.sessionId,
      sourceDigest: f.entry.sourceDigest,
      value: { status: '', index: 'same' },
    };
    const before = f.add('abort-before', record),
      after = f.add('abort-after', record);
    const host = structuredClone(f.host);
    host.result.role = 'p1-sync';
    host.result.assertions = [
      {
        id: 'sync.abort',
        caseId: 'p1-sync',
        operation: 'mergeAbort',
        invocationKind: 'native-api',
        rootUri: 'file:///synthetic/fixture',
        beforeArtifactId: before,
        afterArtifactId: after,
        expected: record.value,
        actual: record.value,
        observations: { oracle: 'synthetic typed abort oracle' },
      },
    ];
    f.rewrite('launcher-p1-sync', host);
    f.index.clauseEvidence = [
      {
        clauseId: 'BR-06.2',
        entryId: 'entry',
        caseId: 'p1-sync',
        assertionIds: ['sync.abort'],
        artifactIds: [before, after, 'launcher-p1-sync', 'run'],
        kind: 'native-api',
      },
    ];
    f.save();
    assert.equal(
      loadEvidence(f.path, f.source, [{ id: 'BR-06.2' }]).evidence.get('BR-06.2').supported,
      true,
    );
  }));
