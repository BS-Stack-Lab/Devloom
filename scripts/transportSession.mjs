import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  openSync,
  writeSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { root, upstream, prepare } from './upstream.mjs';
import { developmentProfile, developmentArguments } from './developmentProfile.mjs';
import { buildLocalArtifact } from './localExtensionArtifact.mjs';
import { ensureLocalExtension, localEnvironment } from './localExtensionInstall.mjs';
import { CDP, delay, ownedTarget, waitFor } from './commitStateUI.mjs';
import { adapter, environment, git, privatePath } from '../dist/tests/transportGit.js';

export const write = (path, value) =>
  writeFileSync(path, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
const digest = (value) => createHash('sha256').update(value).digest('hex');
export function boundedHostLog(host, path, onFailure) {
  const limit = 4 * 1024 * 1024;
  const tail = 65536;
  const storage = Buffer.alloc(limit);
  const descriptor = openSync(path, 'wx', 0o600);
  let retained = 0;
  let failed = false;
  let closed = false;
  Object.defineProperty(host, 'output', { get: () => storage.subarray(0, retained).toString() });
  const fail = (message) => {
    if (failed) return;
    failed = true;
    host.error ??= message;
    try {
      onFailure();
    } catch {
      host.error ??= 'Application capture shutdown failed';
    }
  };
  return {
    accept(bytes) {
      if (closed || failed) return;
      try {
        const previous = retained;
        const remaining = limit - retained;
        const accepted = Math.min(bytes.length, remaining);
        bytes.copy(storage, retained, 0, accepted);
        if (accepted) assert.equal(writeSync(descriptor, bytes, 0, accepted, retained), accepted);
        retained += accepted;
        if (bytes.length > remaining) {
          const count = Math.min(bytes.length, tail);
          if (count < tail) storage.copy(storage, limit - tail, previous - tail + count, previous);
          bytes.copy(storage, limit - count, bytes.length - count);
          assert.equal(writeSync(descriptor, storage, limit - tail, tail, limit - tail), tail);
          host.logOverflow = true;
          fail('Application output limit exceeded');
        }
      } catch {
        fail('Application log capture failed');
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        closeSync(descriptor);
      } catch {
        fail('Application log close failed');
      }
    },
    statistics: () => ({
      retainedBytes: retained,
      maximumBytes: limit,
      tailBytes: failed ? Math.min(retained, tail) : 0,
      closed,
    }),
  };
}

export function cloneTargetInventory(root) {
  const queue = [{ path: root, relative: '', depth: 0 }];
  const inventory = [];
  while (queue.length) {
    assert.ok(inventory.length < 128);
    const item = queue.pop();
    assert.ok(item.depth <= 8);
    const info = lstatSync(item.path);
    privatePath(item.path, info.isDirectory());
    assert.ok(Number.isSafeInteger(info.dev) && Number.isSafeInteger(info.ino));
    assert.ok(info.size <= 1024 * 1024);
    inventory.push({
      relative: item.relative,
      device: info.dev,
      inode: info.ino,
      mode: info.mode,
      uid: info.uid,
      gid: info.gid,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
      sha256: info.isFile() ? digest(readFileSync(item.path)) : null,
    });
    if (info.isDirectory())
      for (const name of readdirSync(item.path))
        queue.push({
          path: join(item.path, name),
          relative: join(item.relative, name),
          depth: item.depth + 1,
        });
  }
  return inventory.sort((a, b) => a.relative.localeCompare(b.relative));
}

function hostIdentities() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,uid=,lstart=,comm='], {
    encoding: 'utf8',
    timeout: 1000,
    maxBuffer: 1024 * 1024,
  })
    .trim()
    .split('\n')
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(.{24})\s+(.+)$/);
      assert.ok(match, 'Owned application identity unproven');
      return {
        pid: +match[1],
        parent: +match[2],
        group: +match[3],
        uid: +match[4],
        start: match[5],
        command: match[6],
      };
    });
}
export function captureLaunchIdentity(host) {
  const identity = hostIdentities().find((row) => row.pid === host.child.pid);
  assert.ok(
    identity &&
      identity.parent === process.pid &&
      identity.uid === process.getuid() &&
      identity.group === host.child.pid,
    'Owned application launch identity unproven',
  );
  host.launchIdentity = identity;
  host.identities = new Map([[identity.pid, identity]]);
  return identity;
}

export class TransportSession {
  constructor(parent, endpoint, secret, remote, options = {}) {
    assert.ok(parent && isAbsolute(parent));
    const canonical = realpathSync(parent);
    assert.ok(canonical !== realpathSync(root) && !canonical.startsWith(`${realpathSync(root)}/`));
    this.evidence = mkdtempSync(join(canonical, 'transport-native-'));
    this.nonce = randomBytes(16).toString('hex');
    this.id = randomUUID();
    this.sequence = 0;
    this.source = Object.fromEntries(
      [
        'scripts/runGitTransports.mjs',
        'scripts/transportSession.mjs',
        'scripts/transportCgi.mjs',
        'scripts/transportHttps.mjs',
        'scripts/transportSsh.mjs',
        'scripts/transportCredentials.mjs',
        'tests/transportGit.ts',
        'tests/transportHost.ts',
        'tests/transportScenarios.ts',
        'tests/gitTransports.test.mjs',
        'package.json',
        'README.md',
      ].map((name) => [name, digest(readFileSync(join(root, name)))]),
    );
    this.sourceDigest = digest(JSON.stringify(this.source));
    this.temporary = mkdtempSync('/private/tmp/dgt-');
    this.workspace = join(this.temporary, `workspace-${this.nonce}`);
    this.runtime = join(this.temporary, 'broker');
    this.channel = join(this.evidence, 'channel');
    for (const path of [this.workspace, this.runtime, this.channel])
      mkdirSync(path, { mode: 0o700 });
    write(join(this.temporary, '.owner.json'), { nonce: this.nonce });
    const quoted = (value) => JSON.stringify(value);
    const configuration = `[credential]\nhelper =\n[user]\nname = Devloom fixture\nemail = fixture@invalid\n[commit]\ngpgsign = false\n[core]\nhooksPath = ${quoted(join(this.temporary, 'hooks'))}\n${endpoint.protocol === 'https' ? `[http "https://127.0.0.1:${endpoint.port}/"]\nsslVerify = true\nsslCAInfo = ${quoted(secret.ca)}\nproxy =\nfollowRedirects = false\n${options.postBuffer === 1024 ? 'postBuffer = 1024\n' : ''}` : ''}`;
    mkdirSync(join(this.temporary, 'hooks'), { mode: 0o700 });
    this.adapter = adapter(this.temporary, configuration, options.ssh);
    const repository = join(this.workspace, 'repository');
    git(this.workspace, ['clone', remote, repository]);
    this.clones = join(this.workspace, 'clones');
    mkdirSync(this.clones, { mode: 0o700 });
    this.sentinel = join(
      this.clones,
      `${basename(new URL(endpoint.url).pathname).replace(/\.git$/, '')}-preexisting`,
    );
    mkdirSync(this.sentinel, { mode: 0o700 });
    writeFileSync(join(this.sentinel, 'sentinel.txt'), this.nonce, { mode: 0o600 });
    this.parentSentinel = join(this.workspace, 'parent-sentinel.txt');
    writeFileSync(this.parentSentinel, this.nonce, { mode: 0o600 });
    this.env = localEnvironment(root, {
      ...environment(),
      DEVLOOM_GIT_TEST_DIRECTORY: this.runtime,
      VSCODE_DEV: '1',
      VSCODE_SKIP_PRELAUNCH: '1',
    });
    prepare();
    this.profile = developmentProfile(root, `qa-${this.nonce.slice(0, 12)}-transports`);
    assert.equal(this.profile.created, true);
    this.marker = readFileSync(join(this.profile.path, '.devloom-owner.json'), 'utf8');
    write(join(this.profile.path, '.transport-owner.json'), { nonce: this.nonce });
    this.fixture = {
      nonce: this.nonce,
      session: this.id,
      sourceDigest: this.sourceDigest,
      workspace: this.workspace,
      profile: this.profile.userData,
      channel: this.channel,
      gitPath: this.adapter.path,
      repository,
      clones: this.clones,
      url: endpoint.url,
      credentialPath: options.credentials ?? secret.file,
    };
    write(join(this.evidence, 'session.json'), {
      source: this.source,
      sourceDigest: this.sourceDigest,
      fixture: this.fixture,
      runtime: this.runtime,
      profile: this.profile,
      adapter: this.adapter,
    });
  }
  occupyCloneTarget() {
    const path = join(
      this.clones,
      basename(new URL(this.fixture.url).pathname).replace(/\.git$/, ''),
    );
    mkdirSync(path, { mode: 0o700 });
    mkdirSync(join(path, 'nested'), { mode: 0o700 });
    writeFileSync(join(path, 'existing.txt'), `existing target ${this.nonce}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    writeFileSync(
      join(path, 'nested/binary'),
      Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
      { flag: 'wx', mode: 0o600 },
    );
    this.occupiedTarget = { path, before: cloneTargetInventory(path) };
    return this.occupiedTarget;
  }
  cloneInvocation() {
    if (!existsSync(this.adapter.log)) return;
    privatePath(this.adapter.log);
    const bytes = readFileSync(this.adapter.log);
    assert.ok(bytes.length <= 1024 * 1024);
    return bytes
      .toString()
      .split('\n')
      .slice(0, -1)
      .map(JSON.parse)
      .find((item) => item.argv[0] === 'clone' && item.argv[1] === this.fixture.url);
  }
  async install() {
    const bootstrap = await ensureLocalExtension(root, this.profile, buildLocalArtifact(root), {
      env: this.env,
    });
    const settings = JSON.parse(readFileSync(this.profile.settings, 'utf8'));
    writeFileSync(
      this.profile.settings,
      JSON.stringify(
        {
          ...settings,
          'window.title': `transport ${this.nonce}`,
          'window.dialogStyle': 'custom',
          'workbench.startupEditor': 'none',
          'security.workspace.trust.enabled': false,
          'git.path': this.adapter.path,
          'git.autoRepositoryDetection': false,
          'git.openRepositoryInParentFolders': 'never',
          'git.autofetch': 'off',
          'git.useIntegratedAskPass': true,
          'git.terminalAuthentication': false,
          'git.confirmSync': false,
          'git.openAfterClone': 'never',
          'git.enableSmartCommit': false,
          'git.postCommitCommand': 'none',
        },
        null,
        2,
      ),
    );
    const artifact = buildLocalArtifact(root, {
      manifest: {
        name: 'transport-fixture',
        publisher: 'devloom',
        version: '1.0.0',
        engines: { vscode: '^1.146.0' },
        main: './transportHost.js',
        activationEvents: ['onStartupFinished'],
      },
      files: Object.fromEntries(
        ['Host', 'Scenarios', 'Git'].map((name) => [
          `transport${name}.js`,
          join(root, `dist/tests/transport${name}.js`),
        ]),
      ),
      data: { 'fixture.json': this.fixture },
    });
    write(join(this.evidence, 'installation.json'), {
      bootstrap,
      companion: await ensureLocalExtension(root, this.profile, artifact, { env: this.env }),
    });
  }
  async launch(debug = false) {
    const host = (this.host = {
      launched: Date.now(),
      closed: false,
      captured: new Set(),
    });
    const command = debug ? join(upstream, 'scripts/code.sh') : process.execPath;
    const args = debug
      ? [...developmentArguments(root, this.profile, this.workspace), '--remote-debugging-port=0']
      : [
          join(root, 'scripts/devloom.mjs'),
          'start',
          `--dev-profile=${this.profile.id}`,
          this.workspace,
        ];
    host.child = spawn(command, args, {
      cwd: debug ? upstream : root,
      env: this.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    host.captured.add(host.child.pid);
    captureLaunchIdentity(host);
    const log = boundedHostLog(host, join(this.evidence, 'application.log'), () => {
      void this.stopOwnedHost().catch(() => {
        host.error ??= 'Owned application shutdown unproven';
      });
    });
    for (const stream of [host.child.stdout, host.child.stderr]) stream.on('data', log.accept);
    host.child.on('error', (error) => {
      host.error ??= error.message;
    });
    host.child.on('close', (code, signal) => {
      host.closed = true;
      host.exit = { code, signal };
      log.close();
    });
    const active = await waitFor('owned transport companion activation', () => {
      if (host.error) throw new Error(host.error);
      const files = readdirSync(this.channel).filter((name) => name.startsWith('activation-'));
      if (!files.length) return;
      assert.equal(files.length, 1);
      return JSON.parse(readFileSync(join(this.channel, files[0]), 'utf8'));
    });
    for (const key of ['nonce', 'session', 'sourceDigest', 'workspace', 'profile'])
      assert.equal(active[key], this.fixture[key]);
    assert.equal(active.status, 'pass', active.error);
    assert.equal(active.appName, 'Devloom IDE Dev');
    assert.ok(active.started >= host.launched);
    host.mainPid = active.mainPid;
    this.active = active;
    const actualArgs = execFileSync('/bin/ps', ['-p', String(active.mainPid), '-o', 'args='], {
      encoding: 'utf8',
    });
    assert.equal(actualArgs.includes('--remote-debugging-port'), debug);
    for (const flag of ['--extensionDevelopmentPath', '--extensionTestsPath'])
      assert.equal(actualArgs.includes(flag), false);
    assert.ok(
      actualArgs.includes(this.workspace) && actualArgs.includes(this.profile.userData),
      'Foreign application launch arguments',
    );
    const mainIdentity = hostIdentities().find((row) => row.pid === active.mainPid);
    assert.ok(
      mainIdentity &&
        mainIdentity.uid === process.getuid() &&
        mainIdentity.group === host.child.pid,
    );
    const previousMain = host.identities.get(mainIdentity.pid);
    if (previousMain)
      assert.ok(
        previousMain.start === mainIdentity.start &&
          previousMain.uid === mainIdentity.uid &&
          previousMain.group === mainIdentity.group,
        'Application main identity changed',
      );
    host.identities.set(mainIdentity.pid, mainIdentity);
    const tree = this.capture();
    assert.ok(
      tree.some(
        (row) =>
          row.pid === active.mainPid &&
          row.group === host.child.pid &&
          row.command.includes('Code - OSS'),
      ),
    );
    assert.ok(tree.some((row) => row.pid === active.extensionHostPid));
    write(join(this.evidence, 'activation-owned.json'), { active, tree, actualArgs });
    if (debug) {
      const endpoint = await ownedTarget(host, this.profile, this.nonce);
      write(join(this.evidence, 'debug-owned.json'), endpoint);
      this.ui = await CDP.connect(endpoint.target.webSocketDebuggerUrl);
    }
    return active;
  }
  capture() {
    const host = this.host;
    assert.ok(host.launchIdentity && host.identities, 'Owned application launch identity unproven');
    const tree = hostIdentities();
    const byPid = new Map(tree.map((row) => [row.pid, row]));
    const owned = new Set();
    for (const previous of host.identities.values()) {
      const current = byPid.get(previous.pid);
      if (!current) continue;
      assert.ok(
        current.uid === previous.uid &&
          current.start === previous.start &&
          current.group === previous.group,
        'Owned application PID identity changed',
      );
      owned.add(current.pid);
    }
    const group = tree.filter((row) => row.group === host.child.pid);
    let progress = true;
    while (progress) {
      progress = false;
      for (const row of group) {
        assert.equal(row.uid, process.getuid(), 'Foreign application group owner');
        if (!owned.has(row.pid) && owned.has(row.parent)) {
          owned.add(row.pid);
          host.identities.set(row.pid, row);
          progress = true;
        }
      }
    }
    assert.ok(
      group.every((row) => owned.has(row.pid)),
      'Unproven application group member',
    );
    for (const row of group) host.captured.add(row.pid);
    return tree.filter((row) => owned.has(row.pid));
  }
  async stage(action) {
    if (this.host.error) throw new Error(this.host.error);
    const sequence = ++this.sequence;
    const stage = `${sequence}-${action}`;
    const request = {
      nonce: this.nonce,
      session: this.id,
      activation: this.active.activation,
      sequence,
      stage,
      action,
    };
    write(join(this.channel, `${stage}-temporary.json`), request);
    renameSync(join(this.channel, `${stage}-temporary.json`), join(this.channel, 'request.json'));
    const value = await waitFor(
      stage,
      () => {
        if (this.host.error) throw new Error(this.host.error);
        const path = join(this.channel, `result-${stage}.json`);
        return existsSync(path) && JSON.parse(readFileSync(path, 'utf8'));
      },
      45000,
    );
    for (const key of ['nonce', 'session', 'activation', 'sequence', 'stage', 'action'])
      assert.equal(value[key], request[key]);
    for (const key of ['mainPid', 'extensionHostPid', 'workspace', 'profile', 'sourceDigest'])
      assert.equal(value[key], this.active[key]);
    assert.ok(value.observed >= this.active.started && value.observed <= Date.now());
    for (const key of ['storageUri', 'globalStorageUri'])
      assert.ok(value[key].startsWith(`${this.profile.userData}/`));
    assert.equal(value.status, 'pass', value.error);
    if (this.host.error) throw new Error(this.host.error);
    return value.data;
  }
  async settled() {
    return waitFor(
      'native operation settled',
      async () => {
        const value = await this.stage('read');
        return value.operation?.state === 'done' && value;
      },
      30000,
    );
  }
  async cancelUI() {
    assert.ok(this.ui);
    const progress = await waitFor(
      'rendered native clone Cancel',
      async () => {
        const value = await this.ui.evaluate(
          `[...document.querySelectorAll('.notification-list-item')].map(e=>({text:e.innerText,buttons:[...e.querySelectorAll('button,.monaco-button')].map(b=>{const r=b.getBoundingClientRect();return {label:b.innerText,x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height}})})).filter(e=>/Cloning|clone/i.test(e.text))`,
        );
        const matches = value.flatMap((item) =>
          item.buttons
            .filter((button) => button.label === 'Cancel' && button.width > 0)
            .map((button) => ({ ...button, text: item.text })),
        );
        assert.ok(matches.length <= 1);
        return matches[0];
      },
      10000,
    );
    assert.ok(
      progress.text.includes(this.fixture.url),
      'Native progress must identify this exact nonce-owned remote',
    );
    await this.ui.screenshot(join(this.evidence, 'native-cancel-before.png'));
    write(join(this.evidence, 'native-cancel-click.json'), {
      ...this.active,
      progress,
      clicked: Date.now(),
    });
    await this.ui.click(progress);
    await this.ui.screenshot(join(this.evidence, 'native-cancel-after.png'));
  }
  async quit() {
    this.ui?.close();
    this.ui = undefined;
    await this.stage('quit');
    await waitFor(
      'native Main and descendants closed',
      () => this.host.closed && !this.capture().length,
      15000,
    );
    assert.deepEqual(this.host.exit, { code: 0, signal: null });
  }
  async stopOwnedHost() {
    const host = this.host;
    if (host.stopPromise) return host.stopPromise;
    host.stopPromise = (async () => {
      let forced = false;
      try {
        let tree = this.capture();
        if (tree.some((row) => row.group !== host.child.pid || !host.captured.has(row.pid)))
          return { processesClosed: false, forced: false };
        forced = tree.length > 0;
        for (const signal of ['SIGTERM', 'SIGKILL']) {
          if (tree.length) {
            try {
              process.kill(-host.child.pid, signal);
            } catch (error) {
              if (error.code !== 'ESRCH') throw error;
            }
          }
          if (!tree.length && host.closed) break;
          await delay(signal === 'SIGTERM' ? 1000 : 250);
          tree = this.capture();
          if (tree.some((row) => row.group !== host.child.pid || !host.captured.has(row.pid)))
            return { processesClosed: false, forced };
        }
        return { processesClosed: host.closed && tree.length === 0, forced };
      } catch (error) {
        host.stopError =
          error instanceof Error ? error.message : 'Owned application identity unproven';
        return { processesClosed: false, forced };
      }
    })();
    return host.stopPromise;
  }
  async cleanup() {
    this.ui?.close();
    if (this.host) {
      const tree = this.capture();
      write(join(this.evidence, 'cleanup-processes.json'), {
        tree,
        captured: [...this.host.captured],
        closed: this.host.closed,
      });
      const stopped = await this.stopOwnedHost();
      if (!stopped.processesClosed)
        return { ...stopped, leftovers: [this.profile.path, this.temporary] };
      this.forced = stopped.forced;
    }
    assert.equal(readFileSync(join(this.sentinel, 'sentinel.txt'), 'utf8'), this.nonce);
    assert.equal(readFileSync(this.parentSentinel, 'utf8'), this.nonce);
    if (this.occupiedTarget)
      assert.deepEqual(cloneTargetInventory(this.occupiedTarget.path), this.occupiedTarget.before);
    for (const [path, hash] of Object.entries(this.adapter.hashes))
      assert.equal(digest(readFileSync(path)), hash);
    for (const [path, marker] of [
      [this.temporary, '.owner.json'],
      [this.profile.path, '.transport-owner.json'],
    ]) {
      privatePath(path, true);
      assert.equal(JSON.parse(readFileSync(join(path, marker), 'utf8')).nonce, this.nonce);
    }
    assert.equal(readFileSync(join(this.profile.path, '.devloom-owner.json'), 'utf8'), this.marker);
    write(
      join(this.evidence, 'adapter-observed.json'),
      existsSync(this.adapter.log)
        ? readFileSync(this.adapter.log, 'utf8').trim().split('\n').map(JSON.parse)
        : [],
    );
    rmSync(this.profile.path, { recursive: true });
    rmSync(this.temporary, { recursive: true });
    return { processesClosed: true, forced: this.forced ?? false, leftovers: [] };
  }
}
