import * as fs from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFiles, digest, within } from './componentInventoryFiles.mjs';
import { strictGit } from './componentInventoryGit.mjs';
import { collectInventory } from './componentInventoryCollectors.mjs';
import { check, root, upstream } from './upstream.mjs';
export function canonical(value) {
  if (Array.isArray(value))
    return value.map(canonical).sort((left, right) => {
      const a = JSON.stringify(left),
        b = JSON.stringify(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export function evidenceSession(parent, repository = root) {
  if (!parent || !isAbsolute(parent)) throw new Error('evidence-parent-required');
  const target = resolve(parent),
    repo = fs.realpathSync(repository);
  let ancestor = target;
  while (!fs.existsSync(ancestor)) {
    const next = dirname(ancestor);
    if (next === ancestor) throw new Error('output-unavailable');
    ancestor = next;
  }
  if (within(repo, target) || within(repo, fs.realpathSync(ancestor)))
    throw new Error('output-inside-repository');
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const real = fs.realpathSync(target);
  if (within(repo, real)) throw new Error('output-inside-repository');
  return fs.mkdtempSync(resolve(real, 'component-inventory-'));
}
export function writeInventory(session, content) {
  const normalized = canonical(content);
  const report = {
    schemaVersion: 1,
    content: normalized,
    contentDigest: digest(JSON.stringify(normalized)),
    session: { createdAt: new Date().toISOString() },
  };
  const path = resolve(session, 'inventory.json');
  fs.writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return {
    path,
    contentDigest: report.contentDigest,
    scanCompleteness: content.scanCompleteness,
    licenseCoverage: content.licenseCoverage,
    legalApproval: content.legalApproval,
  };
}
export function inventoryMain(args = process.argv.slice(2), environment = process.env) {
  try {
    if (args.length) throw new Error('unsupported-cli-argument');
    const session = evidenceSession(environment.DEVLOOM_EVIDENCE_DIR);
    const files = createFiles(root);
    for (const path of [
      'package.json',
      'upstream.lock.json',
      'product/devloom.json',
      'vendor/code-oss/package.json',
      'vendor/code-oss/product.json',
    ]) {
      const value = files.json(resolve(root, path))?.value;
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('source-provenance-failed');
    }
    if (!files.read(resolve(upstream, '.nvmrc'))) throw new Error('source-provenance-failed');
    const runGit = strictGit(root, upstream);
    let provenance;
    try {
      provenance = check({ readOnly: true, runGit });
    } catch {
      throw new Error('source-provenance-failed');
    }
    const content = collectInventory(files, { ...provenance, identity: runGit.identity });
    if (content.diagnostics.some((item) => ['scope-escape', 'symlink-escape'].includes(item.code)))
      throw new Error('scan-policy-failed');
    const result = writeInventory(session, content);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return content.scanCompleteness === 'complete' ? 0 : 2;
  } catch (error) {
    const codes = new Set([
      'evidence-parent-required',
      'output-inside-repository',
      'unsupported-cli-argument',
      'config-policy',
      'scan-policy-failed',
      'metadata-policy',
      'patch-policy',
      'unsupported-git',
      'unsupported-git-argv',
      'git-provenance-failed',
      'source-provenance-failed',
    ]);
    process.stderr.write(
      `${JSON.stringify({ error: codes.has(error.message) ? error.message : 'inventory-failed' })}\n`,
    );
    return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = inventoryMain();
