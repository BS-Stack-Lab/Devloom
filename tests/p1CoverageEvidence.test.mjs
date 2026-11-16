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
  const add = (id, value, kind = 'json') => {
    const path = join(sessionRoot, id + '.' + (kind === 'json' ? 'json' : 'log')),
      raw = kind === 'json' ? Buffer.from(JSON.stringify(value)) : Buffer.from(value);
    writeFileSync(path, raw, { flag: 'wx', mode: 0o600 });
    entry.artifacts.push({ id, path, sha256: digest(raw), bytes: raw.length, kind });
    return id;
  };
  const run = {
    status: 'pass',
    selected: ['p1-changes'],
    completed: ['p1-changes'],
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
    result: { pid: 12, status: 'pass', sourceDigest, nonce, sessionId, assertions: [] },
  };
  if (producer === 'local-git-v1') {
    add('run', run);
    add('launcher', host);
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
