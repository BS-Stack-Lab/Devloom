import { object } from './commandCatalogCollect.mjs';
const fail = () => {
  throw new Error('catalog-contract-invalid');
};
const text = (value) => typeof value === 'string' && value.trim().length > 0;
export function validateRequirements(snapshot) {
  if (
    !object(snapshot) ||
    snapshot.schema_version !== 2 ||
    !text(snapshot.as_of) ||
    !text(snapshot.baseline) ||
    snapshot.originalTotal !== 200 ||
    snapshot.selectedTotal !== 160 ||
    snapshot.excludedRDTotal !== 40 ||
    snapshot.originalSha256 !==
      '9e20992c98aa9b66a0b3b9dd4a4ab8c314e3dac47d5d41e2343f862956ffd27c' ||
    !Array.isArray(snapshot.requirements) ||
    snapshot.requirements.length !== 160
  )
    fail();
  const ids = new Set(),
    pointers = new Set();
  for (const requirement of snapshot.requirements) {
    if (
      !object(requirement) ||
      !['id', 'feature', 'acceptance', 'verification_id', 'phase', 'status', 'originPointer'].every(
        (key) => text(requirement[key]),
      ) ||
      requirement.id.startsWith('RD-') ||
      ids.has(requirement.id) ||
      pointers.has(requirement.originPointer) ||
      !/^\/requirements\/(?:0|[1-9][0-9]*)$/u.test(requirement.originPointer) ||
      Number(requirement.originPointer.split('/').at(-1)) >= 200 ||
      requirement.status !== 'planned'
    )
      fail();
    ids.add(requirement.id);
    pointers.add(requirement.originPointer);
  }
  return snapshot;
}
export function mapCatalog(collection, snapshot, mappings) {
  validateRequirements(snapshot);
  if (!object(mappings) || mappings.schemaVersion !== 1 || !Array.isArray(mappings.decisions))
    fail();
  const records = new Map(collection.records.map((record) => [record.key, record]));
  const requirements = new Map(
    snapshot.requirements.map((requirement) => [requirement.id, requirement]),
  );
  const decisions = new Map();
  for (const decision of mappings.decisions) {
    const record = records.get(decision.target);
    if (
      !record ||
      decisions.has(decision.target) ||
      decision.sourceSha256 !== record.sourceSha256 ||
      !['mapped', 'excluded', 'internal', 'reference', 'unmapped'].includes(decision.disposition) ||
      !text(decision.reason) ||
      !text(decision.followUpPhase) ||
      !Array.isArray(decision.requirementIds) ||
      !Array.isArray(decision.links) ||
      new Set(decision.requirementIds).size !== decision.requirementIds.length ||
      new Set(decision.links).size !== decision.links.length ||
      decision.requirementIds.some((id) => !requirements.has(id)) ||
      decision.links.some((key) => !records.has(key) || key === decision.target)
    )
      fail();
    if (
      decision.disposition === 'mapped' &&
      !decision.requirementIds.length &&
      !decision.links.length
    )
      fail();
    if (decision.disposition !== 'mapped' && decision.requirementIds.length) fail();
    if (
      decision.links.length &&
      (record.kind !== 'menu' ||
        decision.links.some((key) => !record.references.some((ref) => ref.target === key)))
    )
      fail();
    if (
      ['excluded', 'internal', 'reference'].includes(decision.disposition) &&
      !text(decision.evidence)
    )
      fail();
    decisions.set(decision.target, decision);
  }
  const expand = (record) => {
    const decision = decisions.get(record.key) ?? {
      target: record.key,
      disposition: 'unmapped',
      reason:
        'No reviewed decision for this exact source record; pending semantic analysis in follow-up #13.',
      followUpPhase: 'P0',
      requirementIds: [],
      links: [],
    };
    const lineage = decision.links.map(
      (key) => decisions.get(key) ?? { target: key, disposition: 'unmapped', requirementIds: [] },
    );
    const ids = [
      ...new Set([...decision.requirementIds, ...lineage.flatMap((link) => link.requirementIds)]),
    ];
    const unresolved =
      decision.disposition === 'unmapped' ||
      lineage.some(
        (link) =>
          link.disposition === 'unmapped' ||
          records.get(link.target).labels.some((label) => !label.resolved),
      ) ||
      (decision.disposition === 'mapped' && !ids.length) ||
      record.labels.some((label) => !label.resolved);
    return {
      ...record,
      decision,
      decisionLineage: lineage.map((link) => ({
        target: link.target,
        disposition: link.disposition,
      })),
      requirements: ids.map((id) => requirements.get(id)),
      mappingResolved: !unresolved,
      uiContexts:
        record.kind === 'menu'
          ? [{ pointer: record.pointer, location: record.location, payload: record.payload }]
          : collection.records
              .filter(
                (item) =>
                  item.kind === 'menu' && item.references.some((ref) => ref.target === record.key),
              )
              .map((item) => ({
                pointer: item.pointer,
                location: item.location,
                payload: item.payload,
              })),
    };
  };
  const items = collection.records.map(expand);
  const linked = new Set(
    items.flatMap((item) => item.requirements.map((requirement) => requirement.id)),
  );
  const unresolved = items
    .filter((item) => !item.mappingResolved)
    .map((item) => ({
      key: item.key,
      reason: item.decision.reason,
      unresolvedLabels: item.labels.filter((label) => !label.resolved),
      followUpPhase: item.decision.followUpPhase,
    }));
  const perKind = Object.fromEntries(
    ['command', 'setting', 'menu', 'submenu'].map((kind) => [
      kind,
      {
        total: items.filter((item) => item.kind === kind).length,
        unresolved: items.filter((item) => item.kind === kind && !item.mappingResolved).length,
      },
    ]),
  );
  const dispositions = Object.fromEntries(
    ['mapped', 'excluded', 'internal', 'reference', 'unmapped'].map((disposition) => [
      disposition,
      items.filter((item) => item.decision.disposition === disposition).length,
    ]),
  );
  const mappingCoverage = unresolved.length ? 'incomplete' : 'complete';
  return {
    ...collection,
    records: items,
    requirementOrigin: { ...snapshot, requirements: undefined },
    requirements: snapshot.requirements.map((requirement) => ({
      ...requirement,
      sourceLinkState: linked.has(requirement.id) ? 'linked' : 'unlinked',
      runtimeVerification: 'not-assessed',
    })),
    mappingCoverage,
    runtimeVerification: 'not-assessed',
    p0MappingGate:
      collection.collectionCompleteness === 'complete' && mappingCoverage === 'complete'
        ? 'pass'
        : 'not-passed',
    summary: {
      perKind,
      dispositions,
      unresolved,
      unlinkedRequirements: snapshot.requirements.filter(
        (requirement) => !linked.has(requirement.id),
      ).length,
    },
    scope:
      'Fixed-source declaration mapping only; not all P0 requirements, runtime functions, UI support, legal approval or IntelliJ comparison.',
  };
}
