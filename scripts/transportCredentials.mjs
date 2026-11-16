import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
export function privateFile(path, value) {
  writeFileSync(path, value, { flag: 'wx', mode: 0o600 });
  return path;
}
export function owned(path, directory = false) {
  const info = lstatSync(path);
  assert.ok(!info.isSymbolicLink() && info.uid === process.getuid());
  assert.ok(directory ? info.isDirectory() : info.isFile());
  assert.equal(info.mode & 0o077, 0);
  return info;
}
export function safeAncestors(path) {
  const entries = [];
  for (;;) {
    const info = lstatSync(path);
    assert.ok(
      !info.isSymbolicLink() && [0, process.getuid()].includes(info.uid),
      `Unsafe SSH ancestry: ${path}`,
    );
    assert.equal(info.mode & 0o022, 0, `Unsafe SSH ancestry: ${path}`);
    entries.push({ path, uid: info.uid, mode: info.mode & 0o777 });
    const parent = dirname(path);
    if (parent === path) return entries;
    path = parent;
  }
}
export function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}
export function cleanEnvironment(environment = process.env) {
  const env = { ...environment };
  for (const name of Object.keys(env)) {
    if (
      /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*|NAMESPACE|CEILING_DIRECTORIES|SSL.*|TRACE.*|CURL.*|SSH.*)$/.test(
        name,
      ) ||
      /^(https?|all|no)_proxy$/i.test(name) ||
      /^(SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE|SSH_AUTH_SOCK|SSH_ASKPASS|SSH_ASKPASS_REQUIRE)$/.test(
        name,
      )
    )
      delete env[name];
  }
  return env;
}
export function credentials(parent, nonce) {
  assert.match(nonce, /^[a-f0-9]{32}$/);
  const directory = join(realpathSync(parent), `secrets-${nonce}`);
  mkdirSync(directory, { mode: 0o700 });
  owned(directory, true);
  const username = randomBytes(16).toString('hex');
  const password = randomBytes(32).toString('hex');
  const basic = Buffer.from(`${username}:${password}`);
  const file = privateFile(
    join(directory, 'https-credentials.json'),
    JSON.stringify({ username, password }),
  );
  const toolchain = {};
  for (const executable of [
    '/usr/bin/openssl',
    '/usr/bin/ssh',
    '/usr/sbin/sshd',
    '/usr/bin/ssh-keygen',
    '/usr/libexec/sshd-auth',
    '/usr/libexec/sshd-session',
  ]) {
    const path = realpathSync(executable);
    assert.ok(lstatSync(path).isFile());
    toolchain[executable] = hash(readFileSync(path));
  }
  const openssl = (args) => run('/usr/bin/openssl', args);
  for (const name of ['ca', 'foreign-ca']) {
    const config = privateFile(
      join(directory, `${name}.cnf`),
      `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=Devloom fixture ${name} ${nonce}\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n`,
    );
    openssl([
      'req',
      '-new',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-days',
      '1',
      '-config',
      config,
      '-keyout',
      join(directory, `${name}.key`),
      '-out',
      join(directory, `${name}.pem`),
    ]);
  }
  const leaves = {};
  for (const [name, ca, san] of [
    ['valid', 'ca', '127.0.0.1'],
    ['foreign', 'foreign-ca', '127.0.0.1'],
    ['wrong-san', 'ca', '127.0.0.2'],
  ]) {
    const config = privateFile(
      join(directory, `${name}.cnf`),
      `[req]\nprompt=no\ndistinguished_name=dn\nreq_extensions=leaf\n[dn]\nCN=Devloom synthetic loopback\n[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:${san}\n`,
    );
    const key = join(directory, `${name}.key`);
    const cert = join(directory, `${name}.pem`);
    const csr = join(directory, `${name}.csr`);
    openssl([
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-config',
      config,
      '-keyout',
      key,
      '-out',
      csr,
    ]);
    openssl([
      'x509',
      '-req',
      '-in',
      csr,
      '-CA',
      join(directory, `${ca}.pem`),
      '-CAkey',
      join(directory, `${ca}.key`),
      '-set_serial',
      String(Object.keys(leaves).length + 1),
      '-days',
      '1',
      '-sha256',
      '-extfile',
      config,
      '-extensions',
      'leaf',
      '-out',
      cert,
    ]);
    const parsed = new X509Certificate(readFileSync(cert));
    assert.equal(parsed.checkIP(san), san);
    assert.equal(
      parsed.checkIssued(new X509Certificate(readFileSync(join(directory, `${ca}.pem`)))),
      true,
    );
    assert.equal(
      openssl(['pkey', '-in', key, '-pubout']),
      openssl(['x509', '-in', cert, '-pubkey', '-noout']),
    );
    leaves[name] = { key, cert, fingerprint: parsed.fingerprint256, san };
  }
  for (const name of ['host', 'client', 'unauthorized', 'wrong-host'])
    run('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(directory, name)]);
  const empty = privateFile(join(directory, 'empty'), '');
  const ca = join(directory, 'ca.pem');
  return {
    directory,
    username,
    password,
    basic,
    file,
    leaves,
    ca,
    empty,
    toolchain,
    secrets: [username, password, basic.toString('base64')],
  };
}
