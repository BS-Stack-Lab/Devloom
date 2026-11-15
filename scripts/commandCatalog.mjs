import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFiles, digest } from './componentInventoryFiles.mjs';
import { evidenceSession } from './componentInventory.mjs';
import { strictGit } from './componentInventoryGit.mjs';
import { check, root, upstream } from './upstream.mjs';
import { collectCatalog, object, parseJson, stable } from './commandCatalogCollect.mjs';
import { mapCatalog } from './commandCatalogMap.mjs';
export const sourcePin = Object.freeze({
  commit: '69047191fc427f2f92828279aae1d90d8eeda7ab',
  version: '1.146.0',
  node: '24.22.1',
});
export const sourceInputs = Object.freeze([
  {
    extension: 'git',
    manifestSha256: '213a8586480b96f1ecb8f39c6b10939c9772f6caf06668332e608ff8e791f305',
    nlsSha256: 'a0d73208f1b794eaad1c8490a57db9da04536c9da424ad2c8f7db78cd47a35ed',
    expected: { command: 183, setting: 105, menu: 437, submenu: 9 },
  },
  {
    extension: 'github',
    manifestSha256: '3500ec270703aa438481af9c8cd2047336635de74b30a14230908170b3e79135',
    nlsSha256: '2dfa7249166ef16a77040b3d1a1cd431ec1d4b4df9285710b4b698e399fda618',
    expected: { command: 9, setting: 4, menu: 17, submenu: 0 },
  },
  {
    extension: 'github-authentication',
    manifestSha256: 'be63b53c5719de8601abf9e3897a62a4377a45e94c1bb1019d3da07f18a25fa8',
    nlsSha256: '7852038fe4d1e8db9c1c896e5bd92785d92ecc68deb05cc43ed05d19d5b7aa9c',
    expected: { command: 0, setting: 4, menu: 0, submenu: 0 },
  },
]);
export function mandatoryJson(files, path, expectedSha256) {
  const file = files.read(path);
  if (!file || (expectedSha256 && file.sha256 !== expectedSha256))
    throw new Error('source-provenance-failed');
  try {
    const value = parseJson(file.bytes);
    if (!object(value)) throw new Error('invalid-shape');
    return { ...file, value };
  } catch {
    throw new Error('source-provenance-failed');
  }
}
export function acquireInputs(files, repository = root) {
  return sourceInputs.map((source) => ({
    ...source,
    manifest: mandatoryJson(
      files,
      resolve(repository, `vendor/code-oss/extensions/${source.extension}/package.json`),
      source.manifestSha256,
    ).value,
    nls: mandatoryJson(
      files,
      resolve(repository, `vendor/code-oss/extensions/${source.extension}/package.nls.json`),
      source.nlsSha256,
    ).value,
  }));
}
export function writeCatalog(session, content) {
  const normalized = stable(content);
  const report = {
    schemaVersion: 1,
    content: normalized,
    contentDigest: digest(JSON.stringify(normalized)),
    session: { createdAt: new Date().toISOString() },
  };
  const path = resolve(session, 'catalog.json');
  fs.writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return {
    path,
    contentDigest: report.contentDigest,
    collectionCompleteness: content.collectionCompleteness,
    mappingCoverage: content.mappingCoverage,
    runtimeVerification: content.runtimeVerification,
    p0MappingGate: content.p0MappingGate,
  };
}
export function catalogMain(args = process.argv.slice(2), environment = process.env) {
  try {
    if (args.length) throw new Error('unsupported-cli-argument');
    const session = evidenceSession(environment.DEVLOOM_EVIDENCE_DIR);
    const files = createFiles(root);
    const lock = mandatoryJson(files, resolve(root, 'upstream.lock.json')).value;
    if (Object.entries(sourcePin).some(([key, value]) => lock[key] !== value))
      throw new Error('source-provenance-failed');
    for (const path of [
      'package.json',
      'product/devloom.json',
      'vendor/code-oss/package.json',
      'vendor/code-oss/product.json',
    ])
      mandatoryJson(files, resolve(root, path));
    if (!files.read(resolve(upstream, '.nvmrc'))) throw new Error('source-provenance-failed');
    const runGit = strictGit(root, upstream);
    let provenance;
    try {
      provenance = check({ readOnly: true, runGit });
    } catch {
      throw new Error('source-provenance-failed');
    }
    const inputs = acquireInputs(files);
    const requirements = mandatoryJson(files, resolve(root, 'scripts/catalog/requirements.json'));
    const mappings = mandatoryJson(files, resolve(root, 'scripts/catalog/mappings.json'));
    if (
      JSON.stringify(stable(mappings.value.sources)) !== JSON.stringify(stable(sourceInputs)) ||
      JSON.stringify(stable(mappings.value.sourcePin)) !== JSON.stringify(stable(sourcePin))
    )
      throw new Error('catalog-contract-invalid');
    const content = mapCatalog(collectCatalog(inputs), requirements.value, mappings.value);
    content.provenance = {
      ...provenance,
      identity: runGit.identity,
      sourcePin,
      requirementsSha256: requirements.sha256,
      mappingsSha256: mappings.sha256,
    };
    const result = writeCatalog(session, content);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return content.collectionCompleteness === 'complete' ? 0 : 2;
  } catch (error) {
    const codes = new Set([
      'evidence-parent-required',
      'output-inside-repository',
      'unsupported-cli-argument',
      'source-provenance-failed',
      'catalog-contract-invalid',
      'config-policy',
      'metadata-policy',
      'patch-policy',
      'unsupported-git',
      'unsupported-git-argv',
      'git-provenance-failed',
    ]);
    process.stderr.write(
      `${JSON.stringify({ error: codes.has(error.message) ? error.message : 'catalog-failed' })}\n`,
    );
    return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = catalogMain();
