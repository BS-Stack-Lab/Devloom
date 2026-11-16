import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { credentials, privateFile } from './transportCredentials.mjs';
import { httpsServer } from './transportHttps.mjs';
import { sshServer } from './transportSsh.mjs';
import { TransportSession, write } from './transportSession.mjs';
import { waitFor } from './commitStateUI.mjs';
import { git, setup, peerCommit, references } from '../dist/tests/transportGit.js';

export function scanPublicEvidence(root, secrets, privateRoot) {
  const fail = (code) => {
    throw Object.assign(new Error(code), { code });
  };
  const queue = [{ path: root, depth: 0 }];
  let scannedFiles = 0;
  let skippedPrivateRoots = 0;
  let visited = 0;
  while (queue.length) {
    const { path, depth } = queue.pop();
    if (++visited > 10000 || depth > 32) fail('PUBLIC_EVIDENCE_BOUND');
    const info = lstatSync(path);
    if (info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & 0o077)
      fail('PUBLIC_EVIDENCE_UNSAFE');
    if (path === privateRoot) {
      if (!info.isDirectory()) fail('PUBLIC_EVIDENCE_UNSAFE');
      skippedPrivateRoots++;
      continue;
    }
    if (info.isDirectory()) {
      for (const entry of readdirSync(path))
        queue.push({ path: join(path, entry), depth: depth + 1 });
    } else {
      if (!info.isFile()) fail('PUBLIC_EVIDENCE_UNSAFE');
      if (info.size > 8 * 1024 * 1024) fail('PUBLIC_EVIDENCE_BOUND');
      const content = readFileSync(path);
      for (const value of secrets)
        if (content.includes(Buffer.from(value))) fail('PUBLIC_EVIDENCE_SENSITIVE');
      if (
        content.includes(Buffer.from('PRIVATE KEY')) ||
        /Authorization\s*:\s*\S+/i.test(content.toString())
      )
        fail('PUBLIC_EVIDENCE_SENSITIVE');
      scannedFiles++;
    }
  }
  return { scannedFiles, skippedPrivateRoots };
}

async function main() {
  const parent = process.env.DEVLOOM_EVIDENCE_DIR;
  assert.ok(parent && isAbsolute(parent), 'Set an absolute external DEVLOOM_EVIDENCE_DIR');
  const evidence = mkdtempSync(join(parent, 'authenticated-transports-'));
  const result = { started: Date.now(), status: 'fail', completed: [], cases: [] };
  const deadline = Date.now() + 600000;
  function same(before, after) {
    assert.deepEqual(after.state, before.state);
    assert.equal(after.draft, before.draft);
  }
  async function settled(session, action, error) {
    await session.stage(action);
    const observed = await session.settled();
    if (error) assert.match(observed.operation.error ?? '', error);
    else assert.equal(observed.operation.error, undefined);
    return observed;
  }
  async function runCase(protocol, name) {
    assert.ok(Date.now() < deadline, 'Suite deadline');
    const nonce = randomBytes(16).toString('hex');
    const directory = join(evidence, `${protocol}-${name}-${nonce}`);
    mkdirSync(directory, { mode: 0o700 });
    const secret = credentials(directory, nonce);
    const fixture = setup(join(directory, 'repositories'), nonce);
    let server;
    let session;
    let closure;
    const record = { protocol, name, nonce, started: Date.now(), status: 'fail', observations: [] };
    let preserve = false;
    const control = (value) => {
      if (protocol === 'https') server.setControl(value);
      else writeFileSync(server.control, value, { mode: 0o600 });
    };
    const services = () => (protocol === 'https' ? server.events : server.observations().services);
    try {
      server =
        protocol === 'https'
          ? await httpsServer(secret, fixture.remote, nonce, {
              leaf: name === 'wrong-ca' ? 'foreign' : name === 'wrong-san' ? 'wrong-san' : 'valid',
            })
          : await sshServer(secret, fixture.remote, directory, nonce);
      const options = name === 'chunked-push' ? { postBuffer: 1024 } : {};
      if (name === 'auth-denied' && protocol === 'https') {
        const wrong = {
          username: randomBytes(16).toString('hex'),
          password: randomBytes(32).toString('hex'),
        };
        secret.secrets.push(
          wrong.username,
          wrong.password,
          Buffer.from(`${wrong.username}:${wrong.password}`).toString('base64'),
        );
        options.credentials = privateFile(
          join(secret.directory, 'wrong-credentials.json'),
          JSON.stringify(wrong),
        );
      }
      if (protocol === 'ssh')
        options.ssh = server.client(
          `client-${name}`,
          name === 'auth-denied',
          name === 'hostkey-mismatch',
        );
      session = new TransportSession(directory, server, secret, fixture.remote, options);
      record.sessionEvidence = session.evidence;
      await session.install();
      await session.launch(name === 'cancel-ui');
      const beforeRefs = references(fixture.remote);
      if (name === 'chunked-push') {
        await session.stage('connect');
        const committed = await session.stage('large-commit');
        const pushed = await settled(session, 'push');
        const actual = git(fixture.remote, ['rev-parse', 'refs/heads/main']);
        assert.equal(actual, committed.state.head);
        assert.ok(
          server.events.some(
            (event) =>
              event.kind === 'body-complete' && event.mode === 'chunked' && event.bytes > 1024,
          ),
        );
        record.observations.push({
          requestedPostBuffer: 1024,
          committed,
          pushed,
          remoteSha: actual,
        });
      } else if (name === 'success') {
        const clone = await settled(session, 'clone');
        assert.ok(clone.operation.destination?.startsWith(`${session.clones}/`));
        assert.equal(git(clone.operation.destination, ['rev-parse', 'HEAD']), fixture.head);
        assert.equal(git(clone.operation.destination, ['rev-parse', 'HEAD^{tree}']), fixture.tree);
        assert.deepEqual(
          readFileSync(join(clone.operation.destination, 'fixture.txt')),
          readFileSync(join(fixture.peer, 'fixture.txt')),
        );
        await session.stage('use-clone');
        const before = await session.stage('read');
        const next = peerCommit(fixture.peer, fixture.remote, nonce);
        const fetched = await settled(session, 'fetch');
        same(before, fetched);
        assert.equal(
          git(clone.operation.destination, ['rev-parse', 'refs/remotes/origin/main']),
          next,
        );
        const pulled = await settled(session, 'pull');
        assert.equal(pulled.state.head, next);
        assert.deepEqual(
          readFileSync(join(clone.operation.destination, 'fixture.txt')),
          readFileSync(join(fixture.peer, 'fixture.txt')),
        );
        const committed = await session.stage('commit');
        const pushed = await settled(session, 'push');
        assert.equal(git(fixture.remote, ['rev-parse', 'refs/heads/main']), committed.state.head);
        assert.equal(pushed.native.head.upstream.name, 'main');
        assert.equal(
          git(clone.operation.destination, ['rev-parse', 'refs/remotes/origin/main']),
          committed.state.head,
        );
        if (protocol === 'https') {
          const large = await session.stage('large-commit');
          await settled(session, 'push');
          assert.equal(git(fixture.remote, ['rev-parse', 'refs/heads/main']), large.state.head);
          assert.ok(
            server.events.some(
              (event) =>
                event.kind === 'body-complete' && event.mode === 'chunked' && event.bytes > 1024,
            ),
          );
          assert.ok(
            server.events.some(
              (event) => event.kind === 'body-complete' && event.mode === 'length',
            ),
          );
          assert.ok(pushed.credentials.length > 0);
          assert.ok(server.events.some((event) => event.kind === 'auth-denied'));
        } else
          assert.ok(
            server
              .observations()
              .authentication.some((line) => line.includes('Accepted publickey')),
          );
        for (const root of [fixture.remote, clone.operation.destination])
          git(root, ['fsck', '--full']);
        record.observations.push({ clone, next, fetched, pulled, committed, pushed });
      } else if (['auth-denied', 'wrong-ca', 'wrong-san', 'hostkey-mismatch'].includes(name)) {
        const expected =
          name === 'auth-denied'
            ? protocol === 'https'
              ? /Authentication failed|authentication failed|401/
              : /Permission denied.*publickey/s
            : name === 'wrong-ca'
              ? /certificate.*(issuer|verify|self.signed)|SSL certificate problem/i
              : name === 'wrong-san'
                ? /certificate.*(subject|name|127\.0\.0\.1)|no alternative certificate/i
                : /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/;
        await session.stage('protect');
        const before = await session.stage('read');
        for (const action of name === 'auth-denied'
          ? ['clone', 'fetch', 'pull', 'push']
          : ['clone', 'fetch']) {
          if (action !== 'clone') await session.stage('connect');
          const deniedBefore =
            protocol === 'https'
              ? server.events.filter((event) => event.kind === 'auth-denied').length
              : server
                  .observations()
                  .authentication.filter((line) => line.includes('Failed publickey')).length;
          const after = await settled(session, action, expected);
          same(before, after);
          if (name === 'auth-denied') {
            const deniedAfter =
              protocol === 'https'
                ? server.events.filter((event) => event.kind === 'auth-denied').length
                : server
                    .observations()
                    .authentication.filter((line) => line.includes('Failed publickey')).length;
            assert.ok(
              deniedAfter > deniedBefore,
              'Each operation must reach the intended authentication rejection',
            );
          }
          assert.equal(references(fixture.remote), beforeRefs);
          record.observations.push({ action, before, after });
        }
        if (protocol === 'https') {
          assert.equal(
            server.events.some((event) => event.kind === 'backend-start'),
            false,
          );
          if (name !== 'auth-denied')
            assert.equal(
              server.events.some((event) => event.kind === 'authenticated'),
              false,
            );
          else assert.ok(server.events.some((event) => event.kind === 'auth-denied'));
        } else {
          assert.equal(server.observations().services.length, 0);
          assert.equal(
            server
              .observations()
              .authentication.some((line) => line.includes('Accepted publickey')),
            false,
          );
          if (name === 'auth-denied')
            assert.ok(
              server
                .observations()
                .authentication.some((line) => line.includes('Failed publickey')),
            );
        }
      } else {
        const action =
          name.startsWith('cancel') || name === 'interrupt-clone'
            ? 'clone'
            : name === 'interrupt-fetch'
              ? 'fetch'
              : name === 'interrupt-pull'
                ? 'pull'
                : 'push';
        if (action !== 'clone') await session.stage('connect');
        if (action === 'push') await session.stage('commit');
        await session.stage('protect');
        const before = await session.stage('read');
        const previous = git(fixture.remote, ['rev-parse', 'refs/heads/main']);
        const post = name === 'push-post-ref';
        if (post) {
          const ready = join(directory, 'post-update-ready');
          const release = join(directory, 'post-update-release');
          const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
          writeFileSync(
            join(fixture.remote, 'hooks/post-receive'),
            `#!/bin/sh\nprintf ready > ${quote(ready)}\ni=0\nwhile ! test -f ${quote(release)} && test "$i" -lt 200; do /bin/sleep 0.05; i=$((i+1)); done\n`,
            { flag: 'wx', mode: 0o700 },
          );
          await session.stage(action);
          await waitFor('actual post-ref-update hook', () => existsSync(ready), 10000);
          assert.equal(git(fixture.remote, ['rev-parse', 'refs/heads/main']), before.state.head);
          control('disconnect');
          if (protocol === 'ssh')
            await waitFor(
              'owned SSH disconnect acknowledged before hook release',
              () => services().some((event) => event.kind === 'disconnected'),
              3000,
            );
          writeFileSync(release, 'release', { mode: 0o600 });
        } else {
          control('hold');
          await session.stage(action);
          await waitFor(
            'authenticated held native transfer',
            () => services().some((event) => event.kind === 'held'),
            10000,
          );
          if (action === 'clone') {
            const destination = join(
              session.clones,
              basename(new URL(server.url).pathname).replace(/\.git$/, ''),
            );
            await waitFor(
              'actual partial clone .git',
              () => existsSync(join(destination, '.git')),
              5000,
            );
          }
          const during = await session.stage('read');
          record.observations.push({ during });
          if (name === 'cancel-api') await session.stage('cancel');
          else if (name === 'cancel-ui') await session.cancelUI();
          else control('disconnect');
          if (name.startsWith('cancel')) control('release');
        }
        const after = await session.settled();
        assert.ok(after.operation.error, 'Interrupted operation must reject');
        assert.doesNotMatch(
          after.operation.error,
          /Authentication failed|Permission denied.*publickey|SSL certificate|Host key verification/i,
        );
        same(before, after);
        const actual = git(fixture.remote, ['rev-parse', 'refs/heads/main']);
        assert.equal(actual, post ? before.state.head : previous);
        assert.equal(references(fixture.remote), `${actual} refs/heads/main`);
        if (name.startsWith('cancel')) {
          assert.match(after.operation.error, /quarantined/);
          const journal = JSON.parse(readFileSync(join(session.runtime, 'ownership.json'), 'utf8'));
          assert.equal(journal.record.state, 'quarantined');
          await session.stage('refused-write');
          record.observations.push({ journal });
        }
        record.observations.push({
          before,
          after,
          remoteBefore: previous,
          remoteAfter: actual,
          classification: post ? 'committed-but-unacknowledged' : 'interrupted-before-ref-update',
          partialDestination: after.destinationExists ? 'preserved-incomplete' : 'native-cleaned',
        });
        preserve = protocol === 'https';
      }
      await session.quit();
      record.status = 'pass';
    } catch (error) {
      record.error = error instanceof Error ? error.stack : String(error);
      if (session?.active && !session.host.closed)
        await session.quit().catch((quitError) => {
          record.quitError = String(quitError);
        });
    } finally {
      if (session) {
        record.cleanup = await session.cleanup().catch((error) => ({ leftovers: [String(error)] }));
        if (record.cleanup.forced || record.cleanup.leftovers.length) record.status = 'fail';
      }
      if (server) {
        try {
          await server.close();
          closure = 'closed';
        } catch (error) {
          closure = String(error);
          preserve = true;
          if (!/Live HTTP backend preserved|Rejected HTTP relay obligation preserved/.test(closure))
            record.status = 'fail';
        }
        record.server =
          protocol === 'https'
            ? { events: server.events, statistics: server.statistics(), closure }
            : { ...server.observations(), closure };
      }
      record.finished = Date.now();
      if (session)
        record.evidencePrivacy = scanPublicEvidence(
          session.evidence,
          secret.secrets,
          secret.directory,
        );
      const exported = JSON.stringify(record);
      for (const value of secret.secrets)
        assert.equal(exported.includes(value), false, 'Sensitive evidence blocked');
      assert.equal(exported.includes('PRIVATE KEY'), false);
      write(join(directory, 'case-result.json'), record);
      if (!preserve && closure === 'closed') rmSync(secret.directory, { recursive: true });
      result.cases.push({
        protocol,
        name,
        status: record.status,
        path: join(directory, 'case-result.json'),
      });
    }
    assert.equal(record.status, 'pass', record.error);
    result.completed.push(`${protocol}:${name}`);
  }
  try {
    for (const protocol of ['https', 'ssh']) {
      await runCase(protocol, 'success');
      if (protocol === 'https') await runCase(protocol, 'chunked-push');
      await runCase(protocol, 'auth-denied');
      for (const negative of protocol === 'https'
        ? ['wrong-ca', 'wrong-san']
        : ['hostkey-mismatch']) {
        await runCase(protocol, 'success');
        await runCase(protocol, negative);
      }
      for (const name of [
        'cancel-api',
        'cancel-ui',
        'interrupt-clone',
        'interrupt-fetch',
        'interrupt-pull',
        'push-pre-ref',
        'push-post-ref',
      ])
        await runCase(protocol, name);
    }
    result.status = 'pass';
  } catch (error) {
    result.error = error instanceof Error ? error.stack : String(error);
  } finally {
    result.finished = Date.now();
    write(join(evidence, 'run-result.json'), result);
  }
  process.stdout.write(
    `Authenticated transports ${result.status}: ${join(evidence, 'run-result.json')}\n`,
  );
  if (result.status !== 'pass') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
