import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  realpathSync,
  existsSync,
} from 'node:fs';
import { resolve, relative, dirname, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gitEnvironment, gitPrefix } from './componentInventoryGit.mjs';
import { parseJson, stable } from './commandCatalogCollect.mjs';
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const sourcePaths = [
  'scripts/p1Coverage.mjs',
  'scripts/p1CoverageEvidence.mjs',
  'scripts/catalog/p1Clauses.json',
  'tests/p1Coverage.test.mjs',
  'tests/p1CoverageEvidence.test.mjs',
  'scripts/localGitSession.mjs',
  'scripts/localGitPresentation.mjs',
  'scripts/runLocalGit.mjs',
  'tests/localGitP1Host.ts',
  'tests/localGitP1Changes.ts',
  'tests/localGitP1Sync.ts',
  'tests/localGitConcurrencyHost.ts',
  'tests/localGitFixtures.ts',
  'tests/localGitAutofetch.test.mjs',
  'tests/localGitAutofetch.ts',
  'tests/localGitSession.test.mjs',
  'README.md',
];
const requireValue = (condition, code = 'INVALID_EVIDENCE') => {
  if (!condition) throw new Error(code);
};
const hex = (value, length = 64) =>
  typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const git = (root, args) => {
  for (const [key, value] of Object.entries(process.env))
    if (
      value &&
      (/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG|CONFIG_SYSTEM|CONFIG_GLOBAL|CONFIG_PARAMETERS|NAMESPACE|CEILING_DIRECTORIES)$/.test(
        key,
      ) ||
        /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key) ||
        (key === 'GIT_CONFIG_COUNT' && value !== '0'))
    )
      throw new Error('GIT_ROUTING_REFUSED');
  return execFileSync('/opt/homebrew/bin/git', [...gitPrefix, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 4 * 1024 * 1024,
    env: gitEnvironment,
  }).trim();
};
export function sourceBinding(root) {
  root = realpathSync(root);
  const paths = [
    ...new Set([...git(root, ['ls-files', '-z']).split('\0').filter(Boolean), ...sourcePaths]),
  ].sort();
  const files = Object.fromEntries(
    paths
      .filter((path) => existsSync(join(root, path)))
      .map((path) => [path, digest(readFileSync(join(root, path)))]),
  );
  const native = join(root, 'vendor/code-oss');
  const nativePaths = [
    ...new Set([
      ...git(native, ['diff', '--name-only']).split('\n').filter(Boolean),
      'extensions/git/src/api/git.d.ts',
      'extensions/git/src/autofetch.ts',
      'extensions/git/src/commands.ts',
      'extensions/git/src/repository.ts',
    ]),
  ].sort();
  return {
    root,
    branch: git(root, ['branch', '--show-current']),
    baseCommit: '3d0eda149c54ef0b6bff9d2d95795d383ae9e43f',
    headCommit: git(root, ['rev-parse', 'HEAD']),
    files,
    nativePin: git(native, ['rev-parse', 'HEAD']),
    nativeWorkingFiles: Object.fromEntries(
      nativePaths.map((path) => [path, digest(readFileSync(join(native, path)))]),
    ),
    requirementsSha256: files['scripts/catalog/requirements.json'],
  };
}
function safeAncestors(path) {
  for (let current = path; ; current = dirname(current)) {
    const stat = lstatSync(current);
    requireValue(
      !stat.isSymbolicLink() &&
        (stat.uid === 0 || stat.uid === process.getuid()) &&
        !(stat.mode & 0o022),
      'UNSAFE_PATH',
    );
    if (current === dirname(current)) break;
  }
}
export function boundedFile(path, sessionRoot, limit = 8 * 1024 * 1024) {
  requireValue(isAbsolute(path) && isAbsolute(sessionRoot), 'INVALID_PATH');
  const root = realpathSync(sessionRoot);
  requireValue(
    root === sessionRoot &&
      path === resolve(path) &&
      relative(root, path) !== '' &&
      !relative(root, path).startsWith('..') &&
      !isAbsolute(relative(root, path)),
    'PATH_ESCAPE',
  );
  safeAncestors(dirname(path));
  const before = lstatSync(path);
  requireValue(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.uid === process.getuid() &&
      !(before.mode & 0o022) &&
      before.size <= limit,
    'UNSAFE_FILE',
  );
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    requireValue(
      stat.isFile() &&
        stat.uid === process.getuid() &&
        !(stat.mode & 0o022) &&
        stat.ino === before.ino &&
        stat.dev === before.dev &&
        stat.size === before.size &&
        stat.size <= limit,
      'STALE_FILE',
    );
    const bytes = readFileSync(fd);
    requireValue(bytes.length === stat.size, 'TRUNCATED_FILE');
    return bytes;
  } finally {
    closeSync(fd);
  }
}
const unique = (values) => new Set(values).size === values.length;
const date = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT/.test(value) &&
  Number.isFinite(Date.parse(value));
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
const p1Cases = ['p1-changes', 'p1-sync'];
const knownCases = [...baseCases, ...p1Cases];
const validCases = (values) =>
  Array.isArray(values) &&
  values.length > 0 &&
  values.length <= knownCases.length &&
  unique(values) &&
  values.every((value) => typeof value === 'string' && knownCases.includes(value));
const sameCases = (a, b) => a.length === b.length && a.every((value) => b.includes(value));
const producers = ['local-git-v1', 'commit-state-v1', 'git-transports-v1', 'node-test-v1'];
export const nativeAssertions = Object.freeze({
  'changes.status': {
    caseId: 'p1-changes',
    operation: 'state',
    clauses: ['CHG-01.1', 'CHG-01.2', 'CHG-01.3', 'CHG-01.4', 'CHG-01.5', 'CHG-01.6'],
  },
  'changes.external': {
    caseId: 'p1-changes',
    operation: 'watcher',
    clauses: ['REP-14.1', 'REP-14.2'],
  },
  'changes.paired': {
    caseId: 'p1-changes',
    operation: 'vscode.diff',
    clauses: ['CHG-02.1', 'CHG-02.2', 'CHG-02.3'],
  },
  'changes.layout': {
    caseId: 'p1-changes',
    operation: 'diffEditor.renderSideBySide',
    clauses: ['CHG-03.1'],
  },
  'changes.whitespace': {
    caseId: 'p1-changes',
    operation: 'diffEditor.ignoreTrimWhitespace',
    clauses: ['CHG-03.2', 'CHG-03.3'],
  },
  'changes.folder': {
    caseId: 'p1-changes',
    operation: 'add/revert',
    clauses: ['CHG-04.2', 'CHG-04.4', 'CHG-04.5'],
  },
  'changes.all': {
    caseId: 'p1-changes',
    operation: 'git.stageAll/git.unstageAll',
    clauses: ['CHG-04.3', 'CHG-04.4', 'CHG-04.5'],
  },
  'sync.ff': { caseId: 'p1-sync', operation: 'merge', clauses: ['BR-06.1'] },
  'sync.merge': { caseId: 'p1-sync', operation: 'merge', clauses: ['BR-06.1'] },
  'sync.abort': { caseId: 'p1-sync', operation: 'mergeAbort', clauses: ['BR-06.2'] },
  'sync.fetch': {
    caseId: 'p1-sync',
    operation: 'git.fetchAll/git.fetchPrune',
    clauses: ['SYN-01.1', 'SYN-01.2', 'SYN-01.3'],
  },
  'sync.pull': { caseId: 'p1-sync', operation: 'git.pull', clauses: ['SYN-02.1'] },
  'sync.rebase': { caseId: 'p1-sync', operation: 'git.pullRebase', clauses: ['SYN-02.2'] },
  'sync.divergence': { caseId: 'p1-sync', operation: 'git.pull', clauses: [] },
  'sync.aheadBehind': { caseId: 'p1-sync', operation: 'state.HEAD', clauses: [] },
});
function assertionOracle(assertion, artifacts) {
  const before = artifacts.get(assertion.beforeArtifactId)?.value;
  const after = artifacts.get(assertion.afterArtifactId)?.value;
  if (!before || !after) return false;
  for (const item of [before, after])
    for (const key of ['nonce', 'sessionId', 'sourceDigest'])
      if (item[key] !== assertion[key]) return false;
  const a = before.value,
    b = after.value;
  switch (assertion.id) {
    case 'changes.folder':
      return (
        a.index === b.index &&
        same(b.stagedPaths, ['folder/nested/two.txt', 'folder/one.txt']) &&
        same(a.disk, assertion.expected) &&
        same(b.disk, assertion.actual)
      );
    case 'changes.all':
      return (
        a.index === b.index &&
        same(b.all, ['fixture.txt', 'folder/nested/two.txt', 'folder/one.txt', 'sibling.txt']) &&
        same(a.disk, assertion.expected)
      );
    case 'changes.status':
      return (
        typeof a.oracle === 'string' &&
        Object.entries(assertion.expected).every(([path, status]) => b.actual[path] === status) &&
        !!b.rendered?.dom
      );
    case 'changes.paired':
      return (
        b.cached?.includes('INDEX SENTINEL') &&
        !b.cached.includes('WORKING SENTINEL') &&
        b.diff?.includes('WORKING SENTINEL') &&
        b.diff.includes('INDEX SENTINEL') &&
        b.staged?.dom &&
        b.unstaged?.dom
      );
    case 'changes.layout':
      return (
        b.layouts?.length === 2 &&
        b.layouts.every((value) => value.dom?.editors?.length) &&
        same(a, assertion.expected)
      );
    case 'changes.whitespace':
      return (
        b.whitespace?.length === 2 &&
        b.whitespace.every((value) => value.dom?.editors?.length) &&
        same(a, assertion.expected)
      );
    case 'changes.external':
      return (
        b.events > 0 &&
        b.oracle?.head === assertion.actual.head &&
        b.commitRendered?.dom &&
        b.checkoutRendered?.dom
      );
    case 'sync.ff':
      return (
        b.head === assertion.actual.head &&
        b.parents.split(' ').filter(Boolean).length === 1 &&
        assertion.actual.parents === 1
      );
    case 'sync.merge':
      return (
        same(b.parents.split(' ').filter(Boolean), assertion.actual) &&
        assertion.actual.length === 2
      );
    case 'sync.abort':
      return same(a, b) && b.status === '';
    case 'sync.fetch':
      return (
        a.file === b.file && a.file === assertion.expected && b.origin === b.other && !b.obsolete
      );
    case 'sync.pull':
      return b.parents.split(' ').length === 2 && b.old !== b.head;
    case 'sync.rebase':
      return b.parents.split(' ').length === 1 && b.old !== b.head;
    default:
      return false;
  }
}
function adapter(entry, artifacts, source) {
  const values = [...artifacts.values()].filter((a) => a.value).map((a) => a.value);
  const run =
    values.find((v) => v.selected && v.completed) ?? values.find((v) => v.completed && v.status);
  if (entry.producer === 'local-git-v1') {
    requireValue(
      run &&
        run.status === 'pass' &&
        validCases(run.selected) &&
        validCases(run.completed) &&
        same(run.selected, run.completed),
      'PRODUCER_INCOMPLETE',
    );
    requireValue(
      validCases(entry.caseIds) && sameCases(entry.caseIds, run.selected),
      'INVALID_CASES',
    );
    requireValue(
      validCases(run.baseScenarios) &&
        sameCases(run.baseScenarios, baseCases) &&
        run.fullSuite === sameCases(run.selected, baseCases) &&
        run.fullBaseSuite === baseCases.every((name) => run.completed.includes(name)) &&
        run.targetedP1Complete === p1Cases.every((name) => run.completed.includes(name)),
      'INVALID_SUITE_FLAGS',
    );
    for (const key of ['nonce', 'sessionId', 'sourceDigest'])
      requireValue(run[key] === entry[key], 'FOREIGN_PRODUCER');
    requireValue(same(run.source, source), 'STALE_PRODUCER');
    const hosts = [...artifacts.values()]
      .filter((artifact) => artifact.value?.launchRecord)
      .map((artifact) => ({
        host: artifact.value,
        path: relative(entry.sessionRoot, artifact.path).split('/'),
      }));
    requireValue(hosts.length > 0, 'MISSING_LAUNCHER');
    for (const { host, path } of hosts) {
      const scenario = path[0];
      requireValue(
        path.length === 3 &&
          path[2] === 'launcher-result.json' &&
          run.selected.includes(scenario) &&
          run.completed.includes(scenario) &&
          entry.caseIds.includes(scenario) &&
          (!p1Cases.includes(scenario) || host.result?.role === scenario),
        'INVALID_LAUNCHER_CASE',
      );
      if (p1Cases.includes(scenario)) {
        requireValue(Array.isArray(host.result?.assertions), 'INVALID_ASSERTION_CASE');
        for (const assertion of host.result.assertions)
          requireValue(
            assertion &&
              assertion.caseId === scenario &&
              (!Object.hasOwn(nativeAssertions, assertion.id) ||
                nativeAssertions[assertion.id].caseId === scenario),
            'INVALID_ASSERTION_CASE',
          );
      }
      requireValue(
        host.code === 0 &&
          host.signal === null &&
          host.status === 'pass' &&
          host.result?.status === 'pass' &&
          !host.firstError &&
          !host.timedOut &&
          host.finalized &&
          host.finalization?.listenersDisposed &&
          host.finalization?.streamsClosed &&
          host.finalization?.timerCleared &&
          host.finalization?.logClosed &&
          host.cleanup?.confirmedClosed &&
          host.cleanup?.leftovers?.length === 0,
        'FAILED_LAUNCHER',
      );
      requireValue(
        host.launchRecord.nonce === entry.nonce &&
          host.launchRecord.canonicalSourceRoot === source.root &&
          host.result.sourceDigest === entry.sourceDigest &&
          host.result.nonce === entry.nonce &&
          host.result.sessionId === entry.sessionId &&
          host.result.pid > 0 &&
          host.pid === host.launchRecord.pid,
        'FOREIGN_HOST',
      );
    }
    requireValue(
      run.selected.every((scenario) => hosts.some(({ path }) => path[0] === scenario)),
      'MISSING_CASE_LAUNCHER',
    );
    return { run, hosts };
  }
  if (entry.producer === 'commit-state-v1') {
    requireValue(
      run?.status === 'pass' &&
        run.nonce === entry.nonce &&
        run.session === entry.sessionId &&
        run.cleanup?.forced === false &&
        run.cleanup?.leftovers?.length === 0 &&
        Array.isArray(run.observations),
      'PRODUCER_INCOMPLETE',
    );
    return {
      gap: 'Existing commit-state observations require clause-specific request/response and rendered review binding; no blanket completion support.',
    };
  }
  if (entry.producer === 'git-transports-v1') {
    requireValue(
      run?.status === 'pass' && run.completed?.length === 29 && Array.isArray(run.cases),
      'PRODUCER_INCOMPLETE',
    );
    for (const value of values.filter((v) => v.protocol && v.name))
      requireValue(
        value.nonce &&
          value.sessionEvidence &&
          value.observations &&
          value.cleanup?.forced === false &&
          value.cleanup?.leftovers?.length === 0 &&
          value.server?.closure === 'closed',
        'PRODUCER_INCOMPLETE',
      );
    return {
      gap: 'Transport success alone does not prove account, product cleanup or physical cancellation clauses.',
    };
  }
  const manifest = values.find((v) => v.log_sha256 && v.code_digest);
  requireValue(
    manifest?.status === 'pass' &&
      manifest.exit_code === 0 &&
      manifest.command === entry.command &&
      manifest.repo_root === entry.cwd,
    'PRODUCER_INCOMPLETE',
  );
  const tap = [...artifacts.values()]
    .find((a) => digest(a.bytes) === manifest.log_sha256)
    ?.bytes.toString();
  requireValue(
    tap && tap.includes('# fail 0') && !/\bSKIP\b|\bTODO\b/.test(tap),
    'PRODUCER_INCOMPLETE',
  );
  return { gap: 'Node tests establish harness behavior, not native acceptance.' };
}
export function loadEvidence(indexPath, source, clauses) {
  const bytes = boundedFile(indexPath, dirname(indexPath), 1024 * 1024);
  const index = parseJson(bytes);
  requireValue(
    index.schemaVersion === 1 &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(index.indexId) &&
      date(index.createdAt),
    'INVALID_INDEX',
  );
  requireValue(
    index.owner?.agentId &&
      (index.owner.role === 'coordinator'
        ? index.owner.slot === null
        : index.owner.role === 'qa' && [1, 2, 3].includes(index.owner.slot)),
    'INVALID_OWNER',
  );
  requireValue(
    hex(index.source?.baseCommit, 40) &&
      hex(index.source?.headCommit, 40) &&
      same(index.source, source),
    'SOURCE_MISMATCH',
  );
  requireValue(
    Array.isArray(index.entries) &&
      index.entries.length <= 1000 &&
      unique(index.entries.map((e) => e.id)) &&
      Array.isArray(index.clauseEvidence) &&
      unique(index.clauseEvidence.map((c) => c.clauseId)),
    'DUPLICATE_EVIDENCE',
  );
  const admitted = new Map(),
    ids = new Set();
  for (const entry of index.entries) {
    requireValue(
      entry.id &&
        producers.includes(entry.producer) &&
        ['executed', 'referenced'].includes(entry.executionRelation) &&
        entry.executedBy &&
        entry.command &&
        entry.cwd === source.root &&
        date(entry.startedAt) &&
        date(entry.finishedAt) &&
        Date.parse(entry.startedAt) <= Date.parse(entry.finishedAt) &&
        entry.exitCode === 0 &&
        /^[a-f0-9]{32}$/.test(entry.nonce) &&
        entry.sessionId &&
        entry.sourceDigest === digest(JSON.stringify(source)),
      'INVALID_ENTRY',
    );
    if (entry.executionRelation === 'executed')
      requireValue(entry.executedBy === index.owner.agentId, 'FOREIGN_OWNER');
    requireValue(
      isAbsolute(entry.sessionRoot) &&
        entry.sessionRoot !== source.root &&
        !entry.sessionRoot.startsWith(source.root + '/') &&
        realpathSync(entry.sessionRoot) === entry.sessionRoot &&
        Array.isArray(entry.caseIds) &&
        unique(entry.caseIds) &&
        Array.isArray(entry.artifacts) &&
        entry.artifacts.length <= 1000,
      'INVALID_SESSION',
    );
    const artifacts = new Map();
    for (const artifact of entry.artifacts) {
      requireValue(
        artifact.id &&
          !ids.has(artifact.id) &&
          hex(artifact.sha256) &&
          Number.isSafeInteger(artifact.bytes) &&
          ['json', 'png', 'log'].includes(artifact.kind),
        'INVALID_ARTIFACT',
      );
      ids.add(artifact.id);
      const raw = boundedFile(
        artifact.path,
        entry.sessionRoot,
        artifact.kind === 'png' ? 16 * 1024 * 1024 : 8 * 1024 * 1024,
      );
      requireValue(
        raw.length === artifact.bytes && digest(raw) === artifact.sha256,
        'ARTIFACT_MISMATCH',
      );
      artifacts.set(artifact.id, {
        ...artifact,
        bytes: raw,
        value: artifact.kind === 'json' ? parseJson(raw) : undefined,
      });
    }
    admitted.set(entry.id, { entry, artifacts, adapted: adapter(entry, artifacts, source) });
  }
  const evidence = new Map();
  for (const proof of index.clauseEvidence) {
    requireValue(
      clauses.some((c) => c.id === proof.clauseId) && admitted.has(proof.entryId),
      'UNKNOWN_CLAUSE',
    );
    const { entry, artifacts, adapted } = admitted.get(proof.entryId);
    requireValue(
      entry.caseIds.includes(proof.caseId) &&
        Array.isArray(proof.assertionIds) &&
        proof.assertionIds.length &&
        unique(proof.assertionIds) &&
        Array.isArray(proof.artifactIds) &&
        proof.artifactIds.length &&
        proof.artifactIds.every((id) => artifacts.has(id)) &&
        [
          'native-api',
          'native-rendered',
          'physical-ui',
          'fixture-cli',
          'static',
          'historical',
        ].includes(proof.kind),
      'INVALID_POINTER',
    );
    let supported = false,
      reason = adapted.gap || 'Evidence level does not establish this clause.';
    if (
      entry.producer === 'local-git-v1' &&
      ['native-api', 'native-rendered'].includes(proof.kind)
    ) {
      const assertions = adapted.hosts
        .filter(({ path }) => path[0] === proof.caseId)
        .flatMap(({ host }) => host.result.assertions ?? []);
      supported = proof.assertionIds.every((id) => {
        const spec = Object.hasOwn(nativeAssertions, id) ? nativeAssertions[id] : undefined,
          actual = assertions.find((a) => a.id === id);
        if (
          !spec ||
          !actual ||
          !spec.clauses.includes(proof.clauseId) ||
          actual.caseId !== spec.caseId ||
          proof.caseId !== spec.caseId ||
          actual.operation !== spec.operation
        )
          return false;
        if (
          !['native-api', 'native-command', 'native-watcher'].includes(actual.invocationKind) ||
          !actual.rootUri?.startsWith('file:') ||
          !actual.beforeArtifactId ||
          !actual.afterArtifactId ||
          !artifacts.has(actual.beforeArtifactId) ||
          !artifacts.has(actual.afterArtifactId) ||
          !same(actual.expected, actual.actual) ||
          !actual.observations?.oracle
        )
          return false;
        return assertionOracle(
          {
            ...actual,
            nonce: entry.nonce,
            sessionId: entry.sessionId,
            sourceDigest: entry.sourceDigest,
          },
          artifacts,
        );
      });
      if (['native-rendered'].includes(proof.kind)) {
        const review = proof.review,
          reviewed = review && artifacts.get(review.artifactId)?.value;
        supported =
          supported &&
          typeof review?.agentId === 'string' &&
          review.agentId.length > 0 &&
          reviewed?.agentId === review.agentId &&
          review.agentId !== entry.executedBy &&
          review?.verdict === 'supported' &&
          reviewed?.nonce === entry.nonce &&
          reviewed?.sourceDigest === entry.sourceDigest &&
          reviewed?.sessionId === entry.sessionId &&
          reviewed?.verdict === 'supported' &&
          proof.artifactIds
            .filter((id) => artifacts.get(id).kind === 'png' || artifacts.get(id).value?.dom)
            .every((id) => reviewed.artifactHashes?.[id] === artifacts.get(id).sha256) &&
          proof.artifactIds.some((id) => artifacts.get(id).kind === 'png') &&
          proof.artifactIds.some((id) => artifacts.get(id).value?.dom);
      }
      if (
        proof.clauseId.startsWith('CHG-01') ||
        proof.clauseId.startsWith('CHG-02') ||
        proof.clauseId.startsWith('CHG-03')
      )
        supported = supported && proof.kind === 'native-rendered';
      if (proof.clauseId === 'BR-06.1')
        supported =
          supported && ['sync.ff', 'sync.merge'].every((id) => proof.assertionIds.includes(id));
      reason = supported
        ? 'Matched current source, native observation and independent oracle.'
        : 'Missing compatible native assertion, object oracle or independent rendered review.';
    }
    evidence.set(proof.clauseId, {
      ...proof,
      supported,
      reason,
      executionRelation: entry.executionRelation,
      executedBy: entry.executedBy,
    });
  }
  return { indexDigest: digest(bytes), evidence };
}
