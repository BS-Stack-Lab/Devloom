import { readFileSync, writeFileSync, realpathSync, mkdtempSync, lstatSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, sourceBinding, loadEvidence } from './p1CoverageEvidence.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function checklist(repository = root) {
  const raw = readFileSync(join(repository, 'scripts/catalog/requirements.json'));
  const requirements = JSON.parse(raw);
  const data = JSON.parse(readFileSync(join(repository, 'scripts/catalog/p1Clauses.json')));
  if (
    digest(raw) !== data.requirementsSha256 ||
    requirements.originalSha256 !== data.canonicalSha256 ||
    requirements.originalTotal !== 200 ||
    requirements.selectedTotal !== 160 ||
    requirements.excludedRDTotal !== 40 ||
    requirements.requirements.length !== 160
  )
    throw new Error('REQUIREMENTS_MISMATCH');
  const rows = requirements.requirements.filter((row) => row.phase === 'P1');
  if (
    rows.length !== 28 ||
    data.clauses.length !== 87 ||
    new Set(data.clauses.map((c) => c.id)).size !== 87 ||
    data.clauses.some(
      (c) => !rows.some((r) => r.id === c.requirementId && r.acceptance === c.acceptance),
    )
  )
    throw new Error('CLAUSE_MISMATCH');
  return {
    rows,
    clauses: data.clauses,
    counts: { canonical: 200, selected: 160, excludedRD: 40, P1: 28, clauses: 87 },
  };
}
export function reportCoverage(inventory, admission = { evidence: new Map() }) {
  const rows = inventory.rows.map((row) => {
    const clauses = inventory.clauses
      .filter((c) => c.requirementId === row.id)
      .map((c) => {
        const proof = admission.evidence.get(c.id);
        return {
          ...c,
          coverageStatus: proof?.supported ? 'supported' : proof ? 'partial' : 'unverified',
          evidence: proof ? [proof] : [],
          gap: proof?.supported
            ? null
            : proof?.reason || 'No current-source producer observation admitted.',
          followUp: proof?.supported ? null : `Execute and independently review: ${c.text}`,
        };
      });
    return {
      ...row,
      coverageStatus: clauses.every((c) => c.coverageStatus === 'supported')
        ? 'supported'
        : clauses.some((c) => c.evidence.length)
          ? 'partial'
          : 'unverified',
      clauses,
    };
  });
  return {
    schemaVersion: 1,
    counts: inventory.counts,
    indexDigest: admission.indexDigest ?? null,
    wholeP1Gate: rows.every((r) => r.coverageStatus === 'supported') ? 'supported' : 'withheld',
    rows,
  };
}
export function renderCoverage(report) {
  return [
    '# P1 acceptance coverage',
    '',
    `Original 200 / selected 160 / excluded RD 40 / P1 28 / clauses 87. Whole P1 gate: ${report.wholeP1Gate}. Original statuses remain planned.`,
    '',
    ...report.rows.flatMap((row) => [
      `## ${row.id} — ${row.coverageStatus}`,
      row.acceptance,
      '',
      ...row.clauses.map(
        (c) => `- ${c.id}: ${c.text} — ${c.coverageStatus}${c.gap ? `; ${c.gap}` : ''}`,
      ),
      '',
    ]),
  ].join('\n');
}
export function coverageMain(env = process.env) {
  try {
    const parent = env.DEVLOOM_EVIDENCE_DIR;
    if (
      !parent ||
      !isAbsolute(parent) ||
      realpathSync(parent) !== parent ||
      lstatSync(parent).isSymbolicLink() ||
      parent === root ||
      parent.startsWith(root + '/')
    )
      throw new Error('INVALID_OUTPUT');
    const source = sourceBinding(root),
      inventory = checklist();
    const admitted = env.DEVLOOM_P1_EVIDENCE_INDEX
      ? loadEvidence(env.DEVLOOM_P1_EVIDENCE_INDEX, source, inventory.clauses)
      : undefined;
    const report = { ...reportCoverage(inventory, admitted), source };
    const directory = mkdtempSync(join(parent, 'p1-coverage-'));
    for (const [name, bytes] of [
      ['coverage.json', JSON.stringify(report, null, 2) + '\n'],
      ['coverage.md', renderCoverage(report)],
    ])
      writeFileSync(join(directory, name), bytes, { flag: 'wx', mode: 0o600 });
    process.stdout.write(
      JSON.stringify({
        directory,
        wholeP1Gate: report.wholeP1Gate,
        indexDigest: report.indexDigest,
        sourceDigest: digest(JSON.stringify(source)),
      }) + '\n',
    );
    return 0;
  } catch {
    process.stderr.write('P1_EVIDENCE_REJECTED\n');
    return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = coverageMain();
