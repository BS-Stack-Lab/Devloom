import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { API, Repository } from '../vendor/code-oss/extensions/git/src/api/git';
import { changes } from './localGitP1Changes';
import { sync } from './localGitP1Sync';
export interface AssertionRecord {
  id: string;
  caseId: string;
  operation: string;
  invocationKind: string;
  rootUri: string;
  beforeArtifactId: string;
  afterArtifactId: string;
  expected: unknown;
  actual: unknown;
  observations: Record<string, unknown>;
}
export interface Context {
  root: string;
  evidence: string;
  nonce: string;
  sessionId: string;
  sourceDigest: string;
  api: API;
  assertions: AssertionRecord[];
  artifact: (name: string, value: unknown) => string;
  observe: (
    id: string,
    repository: Repository,
    operation: string,
    before: unknown,
    after: unknown,
    expected: unknown,
    actual: unknown,
    invocationKind?: string,
  ) => void;
  present: (name: string, request: Record<string, unknown>) => Promise<unknown>;
}
export async function run(): Promise<void> {
  const root = process.env.DEVLOOM_GIT_FIXTURE!,
    evidence = process.env.DEVLOOM_EVIDENCE_DIR!,
    nonce = process.env.DEVLOOM_GIT_NONCE!,
    sessionId = process.env.DEVLOOM_GIT_SESSION!,
    sourceDigest = process.env.DEVLOOM_GIT_SOURCE_DIGEST!;
  const caseId = process.env.DEVLOOM_GIT_SCENARIO!;
  const result = {
    status: 'fail',
    pid: process.pid,
    role: process.env.DEVLOOM_GIT_PROFILE,
    root,
    nonce,
    sessionId,
    sourceDigest,
    activation: randomUUID(),
    startedAt: new Date().toISOString(),
    finishedAt: '',
    assertions: [] as AssertionRecord[],
    gaps: [] as string[],
  };
  const artifact = (name: string, value: unknown) => {
    const id = `${caseId}-${name}`;
    writeFileSync(
      join(evidence, id + '.json'),
      JSON.stringify({ nonce, sessionId, sourceDigest, value }, null, 2),
      { flag: 'wx', mode: 0o600 },
    );
    return id;
  };
  try {
    const extension = vscode.extensions.getExtension<{ getAPI: (version: number) => API }>(
      'vscode.git',
    );
    assert.ok(extension);
    const api = (await extension.activate()).getAPI(1);
    const context: Context = {
      root,
      evidence,
      nonce,
      sessionId,
      sourceDigest,
      api,
      assertions: result.assertions,
      artifact,
      observe(
        id,
        repository,
        operation,
        before,
        after,
        expected,
        actual,
        invocationKind = 'native-api',
      ) {
        assert.deepEqual(actual, expected, id);
        result.assertions.push({
          id,
          caseId,
          operation,
          invocationKind,
          rootUri: repository.rootUri.toString(),
          beforeArtifactId: artifact(id + '-before', before),
          afterArtifactId: artifact(id + '-after', after),
          expected,
          actual,
          observations: { oracle: 'independent read-only Git objects/index/disk snapshot' },
        });
      },
      async present(name, request) {
        const path = join(evidence, `presentation-${name}`);
        writeFileSync(
          path + '-request.json',
          JSON.stringify({ nonce, sessionId, sourceDigest, name, at: Date.now(), ...request }),
          { flag: 'wx', mode: 0o600 },
        );
        const deadline = Date.now() + 15000;
        while (!existsSync(path + '-response.json')) {
          assert.ok(Date.now() < deadline, 'PRESENTATION_TIMEOUT');
          await new Promise((done) => setTimeout(done, 50));
        }
        const response = JSON.parse(readFileSync(path + '-response.json', 'utf8'));
        assert.equal(response.nonce, nonce);
        assert.equal(response.sessionId, sessionId);
        assert.equal(response.sourceDigest, sourceDigest);
        assert.equal(response.status, 'pass', response.error);
        return response;
      },
    };
    if (caseId === 'p1-changes') await changes(context);
    else if (caseId === 'p1-sync') await sync(context);
    else throw new Error('UNKNOWN_P1_CASE');
    result.gaps.push(
      'Physical folder controls, selected remote/ref QuickPick and visible fetch baseline timestamp remain unverified.',
    );
    result.status = 'pass';
  } catch (error) {
    const detail = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
    artifact('failure', {
      error: error instanceof Error ? error.message : 'P1_FAILURE',
      gitErrorCode: detail.gitErrorCode,
      gitCommand: detail.gitCommand,
      exitCode: detail.exitCode,
      stderr: typeof detail.stderr === 'string' ? detail.stderr.slice(0, 8192) : undefined,
      stdout: typeof detail.stdout === 'string' ? detail.stdout.slice(0, 8192) : undefined,
    });
    throw error;
  } finally {
    result.finishedAt = new Date().toISOString();
    writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
  }
}
