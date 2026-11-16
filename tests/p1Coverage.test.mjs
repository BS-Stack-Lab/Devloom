import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checklist, reportCoverage, renderCoverage } from '../scripts/p1Coverage.mjs';
test('exact original 28 and 87 clause conjunctions retain planned fields', () => {
  const inventory = checklist(),
    report = reportCoverage(inventory);
  const original = JSON.parse(
    readFileSync(new URL('../scripts/catalog/requirements.json', import.meta.url)),
  ).requirements.filter((r) => r.phase === 'P1');
  assert.deepEqual(report.counts, {
    canonical: 200,
    selected: 160,
    excludedRD: 40,
    P1: 28,
    clauses: 87,
  });
  assert.deepEqual(
    report.rows.map(({ coverageStatus, clauses, ...row }) => {
      assert.equal(coverageStatus, 'unverified');
      assert.ok(clauses.length);
      return row;
    }),
    original,
  );
  assert.equal(report.wholeP1Gate, 'withheld');
  assert.ok(
    report.rows
      .flatMap((r) => r.clauses)
      .every((c) => c.gap && c.followUp && c.evidence.length === 0),
  );
  assert.match(renderCoverage(report), /REP-01.1/);
});
test('one supported clause never upgrades an unmet original conjunction', () => {
  const inventory = checklist(),
    clause = inventory.clauses[0];
  const report = reportCoverage(inventory, {
    evidence: new Map([[clause.id, { supported: true, kind: 'native-rendered' }]]),
  });
  assert.equal(report.rows[0].coverageStatus, 'partial');
  assert.equal(report.rows[0].status, 'planned');
  assert.equal(report.wholeP1Gate, 'withheld');
});
test('historical static and CLI observations retain their gaps', () => {
  for (const kind of ['historical', 'static', 'fixture-cli']) {
    const inventory = checklist(),
      id = inventory.clauses[0].id;
    const report = reportCoverage(inventory, {
      evidence: new Map([[id, { kind, supported: false, reason: 'Not current native proof' }]]),
    });
    assert.equal(report.rows[0].clauses[0].coverageStatus, 'partial');
    assert.equal(report.rows[0].clauses[0].evidence[0].kind, kind);
    assert.match(report.rows[0].clauses[0].gap, /Not current/);
  }
});
test('all clauses are required independently, including final clause', () => {
  const inventory = checklist(),
    evidence = new Map(inventory.clauses.map((c) => [c.id, { supported: true }]));
  assert.equal(reportCoverage(inventory, { evidence }).wholeP1Gate, 'supported');
  evidence.delete(inventory.clauses.at(-1).id);
  assert.equal(reportCoverage(inventory, { evidence }).wholeP1Gate, 'withheld');
});
