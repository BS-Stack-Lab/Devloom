import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import {
  cleanEnvironment,
  privateFile,
  quote,
  run,
  safeAncestors,
} from './transportCredentials.mjs';
import { delay, processTree, waitFor } from './commitStateUI.mjs';

export async function sshServer(secret, remote, evidence, nonce) {
  assert.notEqual(process.getuid(), 0);
  const ancestry = safeAncestors(secret.directory);
  assert.equal(
    run('/usr/bin/dscl', ['.', '-read', '/Users/bipo', 'UserShell']),
    'UserShell: /bin/zsh',
  );
  assert.equal(existsSync('/etc/zshenv'), false);
  assert.equal(existsSync('/etc/ssh/sshrc'), false);
  const directory = join(secret.directory, 'ssh');
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(join(directory, 'zsh'), { mode: 0o700 });
  privateFile(
    join(directory, 'authorized'),
    `restrict,from="127.0.0.1" ${readFileSync(join(secret.directory, 'client.pub'), 'utf8')}`,
  );
  const dispatcher = privateFile(
    join(directory, 'dispatch.json'),
    JSON.stringify({
      remote,
      nonce,
      events: join(evidence, 'ssh-service.jsonl'),
      control: join(directory, 'control'),
      global: secret.empty,
    }),
  );
  const events = [];
  let child;
  let closed = false;
  const output = Buffer.alloc(1024 * 1024);
  let outputBytes = 0;
  let overflow = false;
  let port;
  let failure;
  let launchIdentity;
  let stopPromise;
  let captured;
  const identity = (pid) => {
    const value = run('/bin/ps', ['-p', String(pid), '-o', 'uid=,lstart='], { timeout: 1000 });
    assert.match(value, new RegExp(`^${process.getuid()}\\s+`));
    return value;
  };
  const capture = () => {
    assert.ok(launchIdentity, 'SSH launch ownership unproven');
    const tree = processTree();
    const direct = tree.find((row) => row.pid === child.pid);
    assert.ok(direct || closed, 'SSH live child identity missing');
    if (direct) assert.equal(direct.parent, process.pid, 'SSH launch parent changed');
    const owned = new Set();
    for (const [pid, previous] of captured) {
      const current = tree.find((row) => row.pid === pid);
      if (!current) continue;
      assert.equal(current.group, child.pid, 'SSH captured group changed');
      assert.equal(identity(pid), previous, 'SSH captured identity changed');
      owned.add(pid);
    }
    const group = tree.filter((row) => row.group === child.pid);
    let progress = true;
    while (progress) {
      progress = false;
      for (const row of group) {
        if (!owned.has(row.pid) && owned.has(row.parent)) {
          assert.ok(captured.size < 128, 'SSH captured process limit');
          captured.set(row.pid, identity(row.pid));
          owned.add(row.pid);
          progress = true;
        }
      }
    }
    assert.ok(
      group.every((row) => owned.has(row.pid)),
      'SSH group ownership unproven',
    );
    return group;
  };
  const stop = () => {
    stopPromise ??= (async () => {
      let group = capture();
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        if (group.length) {
          try {
            process.kill(-child.pid, signal);
          } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
        }
        if (closed && !group.length) return;
        await delay(signal === 'SIGTERM' ? 1000 : 250);
        group = capture();
      }
      assert.ok(closed && !group.length, 'SSH child or group closure unproven');
    })();
    return stopPromise;
  };
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const reservation = net.createServer();
      let config;
      try {
        await new Promise((resolve, reject) =>
          reservation.once('error', reject).listen(0, '127.0.0.1', resolve),
        );
        port = reservation.address().port;
        const fields = {
          Port: port,
          ListenAddress: '127.0.0.1',
          AddressFamily: 'inet',
          HostKey: join(secret.directory, 'host'),
          PidFile: join(directory, 'pid'),
          AuthorizedKeysFile: join(directory, 'authorized'),
          ForceCommand: `${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))} --dispatch ${quote(dispatcher)}`,
          UsePAM: 'no',
          AuthenticationMethods: 'publickey',
          PubkeyAuthentication: 'yes',
          PasswordAuthentication: 'no',
          KbdInteractiveAuthentication: 'no',
          GSSAPIAuthentication: 'no',
          KerberosAuthentication: 'no',
          HostbasedAuthentication: 'no',
          PermitRootLogin: 'no',
          AllowUsers: 'bipo',
          StrictModes: 'yes',
          DisableForwarding: 'yes',
          PermitTTY: 'no',
          PermitUserRC: 'no',
          PermitUserEnvironment: 'no',
          LoginGraceTime: 10,
          MaxStartups: '2:30:3',
          SetEnv: `ZDOTDIR=${join(directory, 'zsh')}`,
          LogLevel: 'VERBOSE',
        };
        config = privateFile(
          join(directory, `server-${attempt}.conf`),
          Object.entries(fields)
            .map(([key, value]) => `${key} ${value}\n`)
            .join(''),
        );
        run('/usr/sbin/sshd', ['-t', '-f', config]);
        const effective = run('/usr/sbin/sshd', ['-T', '-f', config]);
        const parsed = Object.fromEntries(
          effective
            .split('\n')
            .map((line) => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)]),
        );
        for (const [key, value] of Object.entries(fields))
          assert.equal(
            parsed[key.toLowerCase()],
            key === 'ListenAddress' ? `127.0.0.1:${port}` : String(value),
          );
        events.push({ kind: 'effective-config', effective, ancestry });
      } finally {
        await new Promise((resolve, reject) =>
          reservation.close((error) => {
            if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
            else resolve();
          }),
        );
      }
      closed = false;
      failure = undefined;
      outputBytes = 0;
      overflow = false;
      launchIdentity = undefined;
      stopPromise = undefined;
      captured = new Map();
      child = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', config], {
        detached: true,
        env: cleanEnvironment(),
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.on('error', (error) => {
        const code = ['ENOENT', 'EACCES'].includes(error?.code) ? error.code : 'UNKNOWN';
        failure ??= `Native SSH daemon startup failed (${code})`;
      });
      child.once('close', (code, signal) => {
        closed = true;
        events.push({ kind: 'daemon-close', code, signal });
      });
      if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
        await waitFor('failed SSH daemon close', () => closed, 1000).catch(() => {});
        throw new Error('Native SSH daemon has no proven PID');
      }
      const original = identity(child.pid);
      assert.ok(
        processTree().some(
          (row) => row.pid === child.pid && row.parent === process.pid && row.group === child.pid,
        ),
        'SSH daemon launch ancestry unproven',
      );
      captured.set(child.pid, original);
      launchIdentity = original;
      child.stderr.on('data', (data) => {
        if (overflow) return;
        const remaining = output.length - outputBytes;
        const accepted = Math.min(data.length, remaining);
        data.copy(output, outputBytes, 0, accepted);
        outputBytes += accepted;
        if (data.length > remaining) {
          overflow = true;
          failure ??= 'Native SSH daemon output limit exceeded';
          events.push({
            kind: 'daemon-output-limit',
            retainedBytes: outputBytes,
            maximumBytes: output.length,
          });
          void stop().catch(() => {
            failure = 'Native SSH daemon closure unproven';
          });
        }
      });

      try {
        await waitFor(
          'owned native SSH listener',
          () => {
            if (failure) throw new Error(failure);
            if (closed) throw new Error('Native SSH daemon refused startup');
            capture();
            let listener;
            try {
              listener = run('/usr/sbin/lsof', [
                '-nP',
                '-a',
                '-p',
                String(child.pid),
                `-iTCP:${port}`,
                '-sTCP:LISTEN',
              ]);
            } catch {
              return false;
            }
            assert.ok(
              /^\s*COMMAND\s+PID\s+USER\s+FD\s+TYPE\s+DEVICE\s+SIZE\/OFF\s+NODE\s+NAME\s*$/.test(
                listener.split('\n')[0],
              ),
              'SSH listener header unproven',
            );
            const rows = listener
              .split('\n')
              .slice(1)
              .map((row) => row.trim().split(/\s+/));
            assert.ok(rows.length > 0, 'SSH listener ownership unproven');
            assert.ok(
              rows.every(
                (row) =>
                  row.length === 10 &&
                  /^\d+$/.test(row[1]) &&
                  Number(row[1]) === child.pid &&
                  row[4] === 'IPv4' &&
                  row[7] === 'TCP' &&
                  row[8] === `127.0.0.1:${port}` &&
                  row[9] === '(LISTEN)',
              ),
              'SSH listener PID or literal address unproven',
            );
            capture();
            events.push({ kind: 'listener', pid: child.pid, listener });
            return true;
          },
          5000,
        );
        break;
      } catch (error) {
        await stop();
        if (
          failure ||
          !closed ||
          !output.subarray(0, outputBytes).includes('Address already in use') ||
          attempt === 2
        )
          throw error;
      }
    }
    const known = (name, key) =>
      privateFile(
        join(directory, name),
        `[127.0.0.1]:${port} ${readFileSync(join(secret.directory, `${key}.pub`), 'utf8')
          .split(' ')
          .slice(0, 2)
          .join(' ')}\n`,
      );
    const good = known('known-hosts', 'host');
    const wrong = known('wrong-known-hosts', 'wrong-host');
    function client(name, unauthorized = false, mismatch = false) {
      return privateFile(
        join(directory, `${name}.conf`),
        Object.entries({
          Host: '127.0.0.1',
          HostName: '127.0.0.1',
          Port: port,
          User: 'bipo',
          IdentityFile: join(secret.directory, unauthorized ? 'unauthorized' : 'client'),
          IdentitiesOnly: 'yes',
          IdentityAgent: 'none',
          BatchMode: 'yes',
          StrictHostKeyChecking: 'yes',
          UserKnownHostsFile: mismatch ? wrong : good,
          GlobalKnownHostsFile: secret.empty,
          UpdateHostKeys: 'no',
          VerifyHostKeyDNS: 'no',
          ProxyCommand: 'none',
          ProxyJump: 'none',
          ControlMaster: 'no',
          ControlPath: 'none',
          ClearAllForwardings: 'yes',
          RequestTTY: 'no',
          ConnectTimeout: 5,
          ConnectionAttempts: 1,
        })
          .map(([key, value]) => `${key} ${value}\n`)
          .join(''),
      );
    }
    return {
      protocol: 'ssh',
      url: `ssh://bipo@127.0.0.1:${port}${remote}`,
      port,
      directory,
      events,
      client,
      control: join(directory, 'control'),
      observations: () => ({
        events,
        authentication: output
          .subarray(0, outputBytes)
          .toString()
          .split('\n')
          .filter((line) => /Accepted publickey|Failed publickey|Connection closed/.test(line)),
        services: existsSync(join(evidence, 'ssh-service.jsonl'))
          ? readFileSync(join(evidence, 'ssh-service.jsonl'), 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean)
              .map(JSON.parse)
          : [],
      }),
      async close() {
        try {
          writeFileSync(join(directory, 'control'), 'release', { mode: 0o600 });
        } finally {
          await stop();
        }
        const services = existsSync(join(evidence, 'ssh-service.jsonl'))
          ? readFileSync(join(evidence, 'ssh-service.jsonl'), 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean)
              .map(JSON.parse)
          : [];
        const started = services.filter((item) => item.kind === 'service-start');
        await waitFor(
          'captured SSH dispatchers and service descendants closed',
          () => {
            const tree = processTree();
            return started.every(
              (item) =>
                !tree.some(
                  (row) =>
                    row.pid === item.pid ||
                    row.pid === item.childPid ||
                    row.group === item.childPid,
                ),
            );
          },
          10000,
        );
        privateFile(join(evidence, 'ssh-daemon.log'), output.subarray(0, outputBytes));
        if (failure) throw new Error('Native SSH daemon capture failed');
      },
    };
  } catch {
    if (child) {
      try {
        await stop();
      } catch {
        throw new Error('Native SSH startup failed; private daemon ownership or closure unproven');
      }
    }
    throw new Error('Native SSH startup refused');
  }
}

if (process.argv[2] === '--dispatch') {
  const config = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const originalCommand = process.env.SSH_ORIGINAL_COMMAND;
  const service = ['git-upload-pack', 'git-receive-pack'].find(
    (name) => originalCommand === `${name} '${config.remote}'`,
  );
  if (!service) process.exit(125);
  const event = (value) =>
    writeFileSync(
      config.events,
      `${JSON.stringify({ nonce: config.nonce, pid: process.pid, at: Date.now(), service, ...value })}\n`,
      { flag: 'a', mode: 0o600 },
    );
  const child = spawn('/opt/homebrew/bin/git', [service.slice(4), config.remote], {
    env: { ...cleanEnvironment(), GIT_CONFIG_GLOBAL: config.global, GIT_CONFIG_NOSYSTEM: '1' },
    detached: true,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  event({ kind: 'service-start', childPid: child.pid });
  const original = run('/bin/ps', ['-p', String(child.pid), '-o', 'uid=,lstart=']);
  assert.match(original, new RegExp(`^${process.getuid()}\\s+`));
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    assert.equal(run('/bin/ps', ['-p', String(child.pid), '-o', 'uid=,lstart=']), original);
    assert.ok(
      processTree().some(
        (row) => row.pid === child.pid && row.parent === process.pid && row.group === child.pid,
      ),
    );
    process.kill(-child.pid, 'SIGTERM');
    child.stdin.destroy();
    child.stdout.destroy();
    process.stdout.destroy();
    process.stdin.destroy();
  };
  const mode = existsSync(config.control) ? readFileSync(config.control, 'utf8') : '';
  if (mode === 'hold' || mode === 'drop') {
    child.stdout.pause();
    event({ kind: 'held' });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && readFileSync(config.control, 'utf8') === mode) await delay(25);
    if (mode === 'drop') {
      stop();
      process.exitCode = 1;
    }
  }
  let inputBytes = 0;
  let outputBytes = 0;
  let disconnected = false;
  const disconnectNow = () => {
    if (disconnected) return;
    disconnected = true;
    event({ kind: 'disconnected', childPid: child.pid });
    stop();
  };
  const disconnect = setInterval(() => {
    if (existsSync(config.control) && readFileSync(config.control, 'utf8') === 'disconnect') {
      disconnectNow();
    }
  }, 25);
  if (existsSync(config.control) && readFileSync(config.control, 'utf8') === 'disconnect') {
    disconnectNow();
  } else {
    process.stdin.on('data', (bytes) => {
      inputBytes += bytes.length;
    });
    child.stdout.on('data', (bytes) => {
      outputBytes += bytes.length;
    });
    process.stdin.pipe(child.stdin);
    child.stdout.pipe(process.stdout);
  }
  process.on('SIGTERM', stop);
  child.once('close', (code, signal) => {
    clearInterval(disconnect);
    event({ kind: 'service-close', code, signal, inputBytes, outputBytes });
    process.exitCode = code ?? 1;
  });
  child.stdin.on('error', () => {});
}
