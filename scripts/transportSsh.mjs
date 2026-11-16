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
  let output = '';
  let port;
  for (let attempt = 0; attempt < 3; attempt++) {
    const reservation = net.createServer();
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
    const config = privateFile(
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
    await new Promise((resolve) => reservation.close(resolve));
    child = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', config], {
      detached: true,
      env: cleanEnvironment(),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    closed = false;
    child.once('close', (code, signal) => {
      closed = true;
      events.push({ kind: 'daemon-close', code, signal });
    });
    child.stderr.on('data', (data) => {
      output += data;
      if (output.length > 1024 * 1024) child.kill();
    });
    try {
      await waitFor(
        'owned native SSH listener',
        () => {
          if (closed) throw new Error('Native SSH daemon refused startup');
          try {
            const listener = run('/usr/sbin/lsof', [
              '-nP',
              '-a',
              '-p',
              String(child.pid),
              `-iTCP:${port}`,
              '-sTCP:LISTEN',
            ]);
            assert.ok(listener.includes(`127.0.0.1:${port}`));
            events.push({ kind: 'listener', pid: child.pid, listener });
            return true;
          } catch {
            return false;
          }
        },
        5000,
      );
      break;
    } catch (error) {
      if (!closed || !output.includes('Address already in use') || attempt === 2) throw error;
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
      writeFileSync(join(directory, 'control'), 'release', { mode: 0o600 });
      const group = processTree().filter((item) => item.group === child.pid);
      assert.ok(
        group.every((item) => /sshd|node|git|zsh|true/.test(item.command)),
        'Ambiguous SSH descendants preserved',
      );
      if (!closed) process.kill(-child.pid, 'SIGTERM');
      await waitFor(
        'SSH descendants closed',
        () => closed && !processTree().some((item) => item.group === child.pid),
        10000,
      );
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
                  row.pid === item.pid || row.pid === item.childPid || row.group === item.childPid,
              ),
          );
        },
        10000,
      );
      privateFile(join(evidence, 'ssh-daemon.log'), output);
    },
  };
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
