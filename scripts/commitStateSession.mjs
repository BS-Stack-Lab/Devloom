import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { developmentProfile, developmentArguments } from './developmentProfile.mjs';
import { root, upstream, prepare } from './upstream.mjs';
import { delay, waitFor, processTree } from './commitStateUI.mjs';
import { installCompanion } from './commitStateFixture.mjs';
import { buildLocalArtifact } from './localExtensionArtifact.mjs';
import { ensureLocalExtension, localEnvironment } from './localExtensionInstall.mjs';
import { sourceEvidence, backupEvidence } from './commitStateEvidence.mjs';
import {
  isolatedEnvironment,
  setup,
  verifyOwnedPath,
  gitAdapter,
  digest,
  adapterEvidence,
} from '../dist/tests/commitStateFixtures.js';

export const write = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
export function validateResponse(value, request, active, profile) {
  for (const key of ['nonce', 'session', 'activation', 'stage', 'sequence', 'action'])
    assert.equal(value[key], request[key], `Stale response ${key}`);
  for (const key of ['mainPid', 'extensionHostPid', 'workspace', 'profile', 'sourceDigest'])
    assert.equal(value[key], active[key]);
  assert.ok(value.observed >= active.started && value.observed <= Date.now());
  for (const key of ['storageUri', 'globalStorageUri'])
    assert.ok(value[key].startsWith(`${profile.userData}/`));
  assert.equal(value.status, 'pass', value.error);
  return value;
}
export class Session {
  constructor(parent) {
    assert.ok(parent && isAbsolute(parent), 'Set an absolute external DEVLOOM_EVIDENCE_DIR');
    const canonical = realpathSync(parent);
    const repository = realpathSync(root);
    assert.ok(
      canonical !== repository && !canonical.startsWith(`${repository}/`),
      'Evidence must be external',
    );
    this.evidence = mkdtempSync(join(canonical, 'commit-state-'));
    this.nonce = randomBytes(16).toString('hex');
    this.id = randomUUID();
    this.source = sourceEvidence(root);
    this.sourceDigest = digest(JSON.stringify(this.source));
    this.sequence = 0;
    this.deadline = Date.now() + 360000;
    this.hosts = [];
    this.activations = new Set();
    this.temporary = mkdtempSync('/tmp/dcs-');
    write(join(this.temporary, '.owner.json'), { nonce: this.nonce });
    this.workspace = join(this.temporary, `workspace-${this.nonce}`);
    this.runtime = join(this.temporary, 'broker');
    mkdirSync(this.runtime, { mode: 0o700 });
    this.adapter = gitAdapter(this.temporary);
    this.env = {
      ...isolatedEnvironment(),
      DEVLOOM_COMMIT_FIXTURE_GIT: this.adapter.adapter,
      DEVLOOM_GIT_TEST_DIRECTORY: this.runtime,
      VSCODE_DEV: '1',
      VSCODE_SKIP_PRELAUNCH: '1',
    };
    const previous = process.env;
    process.env = this.env;
    try {
      write(join(this.evidence, 'fixture-initialization.json'), {
        nonce: this.nonce,
        session: this.id,
        sourceDigest: this.sourceDigest,
        repositories: setup(this.workspace, this.nonce),
      });
    } finally {
      process.env = previous;
    }
    prepare();
    this.profile = developmentProfile(root, `qa-${this.nonce.slice(0, 12)}-commit`);
    assert.equal(this.profile.created, true, 'Never adopt existing fixture profile');
    this.marker = readFileSync(join(this.profile.path, '.devloom-owner.json'), 'utf8');
    write(join(this.profile.path, '.commit-state-owner.json'), { nonce: this.nonce });
    this.channel = join(this.evidence, 'channel');
    mkdirSync(this.channel, { mode: 0o700 });
    this.fixture = {
      nonce: this.nonce,
      session: this.id,
      channel: this.channel,
      workspace: this.workspace,
      profile: this.profile.userData,
      gitPath: this.adapter.adapter,
      sourceDigest: this.sourceDigest,
    };
    write(join(this.evidence, 'session.json'), {
      nonce: this.nonce,
      session: this.id,
      temporary: this.temporary,
      profile: this.profile,
      source: this.source,
      sourceDigest: this.sourceDigest,
      environment: { adapter: this.adapter, noSystem: this.env.GIT_CONFIG_NOSYSTEM },
      started: Date.now(),
    });
  }
  async prepareInstallation() {
    this.installation = await ensureLocalExtension(root, this.profile, buildLocalArtifact(root), {
      env: this.env,
    });
    this.companion = await installCompanion(root, this.profile, this.fixture, this.env);
    this.env = localEnvironment(root, this.env);
    write(join(this.evidence, 'installation.json'), {
      bootstrap: this.installation,
      companion: this.companion,
    });
  }
  launch(debug) {
    const label = `launch-${this.hosts.length + 1}`;
    const command = debug ? join(upstream, 'scripts/code.sh') : process.execPath;
    const args = debug
      ? [...developmentArguments(root, this.profile, this.workspace), '--remote-debugging-port=0']
      : [
          join(root, 'scripts/devloom.mjs'),
          'start',
          `--dev-profile=${this.profile.id}`,
          this.workspace,
        ];
    const host = {
      label,
      debug,
      launched: Date.now(),
      output: '',
      closed: false,
      captured: new Set(),
    };
    const log = createWriteStream(join(this.evidence, `${label}.log`), {
      flags: 'wx',
      mode: 0o600,
    });
    host.child = spawn(command, args, {
      cwd: debug ? upstream : root,
      env: this.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    host.captured.add(host.child.pid);
    for (const stream of [host.child.stdout, host.child.stderr])
      stream.on('data', (bytes) => {
        host.output += bytes.toString();
        log.write(bytes);
        if (host.output.length > 4 * 1024 * 1024) host.error = 'Oversized app log';
      });
    host.child.once('error', (error) => {
      host.error = error.message;
    });
    host.child.once('close', (code, signal) => {
      host.closed = true;
      host.exit = { code, signal };
      log.end();
    });
    this.hosts.push(host);
    return host;
  }
  capture(host) {
    const tree = processTree();
    for (const row of tree) if (row.group === host.child.pid) host.captured.add(row.pid);
    return tree.filter((row) => row.group === host.child.pid || host.captured.has(row.pid));
  }
  async activation(host) {
    const active = await waitFor('fresh companion activation', () => {
      if (host.error || (host.closed && host.exit.code !== 0))
        throw new Error(host.error ?? JSON.stringify(host.exit));
      const files = readdirSync(this.channel).filter(
        (name) => name.startsWith('activation-') && !this.activations.has(name),
      );
      if (!files.length) return;
      assert.equal(files.length, 1);
      this.activations.add(files[0]);
      return JSON.parse(readFileSync(join(this.channel, files[0]), 'utf8'));
    });
    assert.equal(active.status, 'pass', active.error);
    assert.equal(active.nonce, this.nonce);
    assert.equal(active.session, this.id);
    assert.equal(active.appName, 'Devloom IDE Dev');
    assert.equal(active.sourceDigest, this.sourceDigest);
    assert.ok(active.started >= host.launched);
    assert.equal(active.workspace, realpathSync(this.workspace));
    assert.equal(active.profile, this.profile.userData);
    const tree = this.capture(host);
    assert.ok(
      tree.some(
        (row) =>
          row.pid === active.mainPid &&
          row.group === host.child.pid &&
          row.command.includes('Code - OSS'),
      ),
    );
    host.mainPid = active.mainPid;
    this.active = active;
    const args = execFileSync('/bin/ps', ['-p', String(active.mainPid), '-o', 'args='], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 65536,
    });
    assert.equal(args.includes('--remote-debugging-port'), host.debug);
    assert.equal(args.includes('--extensionDevelopmentPath'), false);
    assert.equal(args.includes('--extensionTestsPath'), false);
    write(join(this.evidence, `${host.label}-owned.json`), { active, tree, args });
    this.backups(host.label + '-activated');
    return active;
  }
  async stage(name, action = 'read') {
    const sequence = ++this.sequence;
    const stage = `stage-${sequence}-${name}-${action}`;
    const request = {
      nonce: this.nonce,
      session: this.id,
      activation: this.active.activation,
      sequence,
      stage,
      name,
      action,
    };
    const path = join(this.channel, `${stage}-request.json`);
    write(path, request);
    renameSync(path, join(this.channel, 'request.json'));
    assert.ok(Date.now() < this.deadline, 'Suite deadline');
    const response = await waitFor(
      stage,
      () => {
        const file = join(this.channel, `result-${stage}.json`);
        return existsSync(file) && JSON.parse(readFileSync(file, 'utf8'));
      },
      Math.min(45000, this.deadline - Date.now()),
    );
    return validateResponse(response, request, this.active, this.profile);
  }
  async settled(name) {
    return waitFor(`${name} native command settlement`, async () => {
      const value = await this.stage(name);
      return value.data.operation?.state === 'done' && value;
    });
  }
  async quit(host) {
    this.backups(host.label + '-before-quit');
    await this.stage('restart', 'quit');
    await waitFor('clean native group exit', () => {
      const tree = this.capture(host);
      return host.closed && tree.length === 0;
    });
    assert.deepEqual(host.exit, { code: 0, signal: null });
    write(join(this.evidence, `${host.label}-exit.json`), {
      ...host.exit,
      exited: Date.now(),
      captured: [...host.captured],
    });
  }
  backups(label) {
    backupEvidence(this.profile, this.evidence, label, {
      nonce: this.nonce,
      session: this.id,
      activation: this.active?.activation,
    });
  }
  async cleanup() {
    const leftovers = [];
    let forced = false;
    for (const host of this.hosts) {
      let tree = this.capture(host);
      write(join(this.evidence, `${host.label}-cleanup.json`), {
        tree,
        captured: [...host.captured],
        closed: host.closed,
      });
      if (tree.length) {
        forced = true;
        if (tree.some((row) => row.group !== host.child.pid || !host.captured.has(row.pid))) {
          leftovers.push(this.profile.path);
          continue;
        }
        for (const signal of ['SIGTERM', 'SIGKILL']) {
          if (tree.length) {
            try {
              process.kill(-host.child.pid, signal);
            } catch (error) {
              if (error.code !== 'ESRCH') throw error;
            }
          }
          await delay(signal === 'SIGTERM' ? 1000 : 250);
          tree = this.capture(host);
        }
      }
      if (tree.length || !host.closed) leftovers.push(this.profile.path);
    }
    if (!leftovers.length) {
      try {
        verifyOwnedPath(this.profile.path, '.commit-state-owner.json', this.nonce);
        assert.equal(
          readFileSync(join(this.profile.path, '.devloom-owner.json'), 'utf8'),
          this.marker,
        );
        assert.equal(developmentProfile(root, this.profile.id).created, false);
        verifyOwnedPath(this.temporary, '.owner.json', this.nonce);
        write(join(this.evidence, 'git-adapter-result.json'), adapterEvidence(this.adapter));
        rmSync(this.profile.path, { recursive: true });
        rmSync(this.temporary, { recursive: true });
      } catch (error) {
        leftovers.push(this.profile.path, this.temporary, String(error));
      }
    } else leftovers.push(this.temporary);
    return { forced, leftovers };
  }
}
