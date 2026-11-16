import { spawn, execFileSync } from 'node:child_process';
import {
  constants,
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
  writeFileSync,
  realpathSync,
  lstatSync,
  createWriteStream,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
export function probeProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('INVALID_PID');
  const text = execFileSync(
    '/bin/ps',
    ['-ww', '-p', String(pid), '-o', 'uid=,pid=,pgid=,lstart=,args='],
    {
      env: { ...process.env, LC_ALL: 'C' },
      encoding: 'utf8',
      timeout: 1000,
      maxBuffer: 65536,
    },
  );
  const lines = text.trim().split('\n');
  const match =
    lines.length === 1 &&
    lines[0].match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/);
  if (!match) throw new Error('MALFORMED_PS');
  return {
    uid: Number(match[1]),
    pid: Number(match[2]),
    detachedPgid: Number(match[3]),
    startIdentity: match[4].replace(/\s+/g, ' '),
    args: match[5],
  };
}
export function groupMembers(group) {
  const text = execFileSync('/bin/ps', ['-axo', 'uid=,pid=,pgid='], {
    encoding: 'utf8',
    timeout: 1000,
    maxBuffer: 1024 * 1024,
  });
  return text
    .trim()
    .split('\n')
    .map((line) => {
      const match = line.trim().match(/^(-?\d+)\s+(\d+)\s+(\d+)$/);
      if (!match) throw new Error('MALFORMED_GROUP');
      return { uid: Number(match[1]), pid: Number(match[2]), detachedPgid: Number(match[3]) };
    })
    .filter((row) => row.detachedPgid === group);
}
function readMarker(path) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size > 65536
  )
    throw new Error('UNSAFE_MARKER');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = fstatSync(fd);
    if (current.ino !== stat.ino || current.dev !== stat.dev || current.size !== stat.size)
      throw new Error('STALE_MARKER');
    const bytes = readFileSync(fd);
    return { value: JSON.parse(bytes), sha256: hash(bytes) };
  } finally {
    closeSync(fd);
  }
}
export function launchOwned(options) {
  const {
    command,
    args,
    cwd,
    env,
    fixtureRoot,
    profile,
    nonce,
    sessionId,
    sourceRoot,
    evidence,
    timeoutMs = 100000,
    authorizationProbe = (value) => value,
    markerProbe = (value) => value,
    initialProbe = probeProcess,
    onChild,
  } = options;
  const expectedProfile = realpathSync(profile);
  const canonicalFixtureRoot = realpathSync(fixtureRoot);
  const canonicalSourceRoot = realpathSync(sourceRoot);
  if (
    !/^[a-zA-Z0-9/_-]+$/.test(expectedProfile) ||
    !/^[a-f0-9]{32}$/.test(nonce) ||
    !expectedProfile.includes(nonce)
  )
    throw new Error('INVALID_PROFILE_NONCE');
  const markerPath = join(canonicalFixtureRoot, `.launch-${sessionId}.json`);
  const state = {
    pid: null,
    code: null,
    signal: null,
    firstError: null,
    timedOut: false,
    ownership: 'pending',
    terminationAttempts: [],
    events: [],
    cleanup: { leftovers: [canonicalFixtureRoot, expectedProfile] },
    finalized: false,
    closed: false,
  };
  let record,
    marker,
    sequence = 0,
    usedSequence = 0,
    timer,
    log,
    output = '',
    stopped = false,
    finalized = false;
  let resolveClose;
  const closePromise = new Promise((done) => {
    resolveClose = done;
  });
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const fail = (code) => {
    state.firstError ??= code;
  };
  const onError = (error) => {
    fail(error.code || 'CHILD_ERROR');
    state.events.push({ type: 'error', at: Date.now(), code: error.code || 'CHILD_ERROR' });
  };
  const onClose = (code, signal) => {
    state.closed = true;
    state.code = code;
    state.signal = signal;
    state.events.push({ type: 'close', at: Date.now(), code, signal });
    if (code !== 0 || signal) fail(signal || 'NONZERO_EXIT');
    resolveClose();
  };
  child.on('error', onError);
  child.once('close', onClose);
  state.pid = child.pid ?? null;
  try {
    const initial = initialProbe(child.pid);
    const own = probeProcess(process.pid);
    if (
      initial.uid !== process.getuid() ||
      initial.pid !== child.pid ||
      initial.detachedPgid !== child.pid ||
      initial.detachedPgid === own.detachedPgid
    )
      throw new Error('INITIAL_IDENTITY');
    record = Object.freeze({
      uid: initial.uid,
      pid: child.pid,
      startIdentity: initial.startIdentity,
      detachedPgid: initial.detachedPgid,
      nonce,
      sessionId,
      canonicalSourceRoot,
      canonicalFixtureRoot,
      canonicalProfile: expectedProfile,
    });
    marker = { schemaVersion: 1, ...record };
    writeFileSync(markerPath, JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
    record = Object.freeze({ ...record, markerSha256: readMarker(markerPath).sha256 });
    state.ownership = 'captured';
    state.launchRecord = record;
  } catch {
    state.ownership = 'ambiguous';
    fail('INITIAL_CAPTURE_FAILED');
  }
  const consume = (bytes) => {
    if (output.length < 4 * 1024 * 1024) {
      output += bytes.toString();
      log?.write(bytes);
    } else fail('LOG_BOUND');
  };
  try {
    log = createWriteStream(join(evidence, 'host.log'), { flags: 'wx', mode: 0o600 });
    log.on('error', () => fail('LOG_ERROR'));
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    onChild?.(child);
  } catch {
    fail('OUTPUT_SETUP_FAILED');
  }
  const authorize = (signal, victim) => {
    if (!record || stopped) throw new Error('OWNERSHIP_AMBIGUOUS');
    const raw = probeProcess(record.pid);
    const sampled = { ...raw, nonce: record.nonce, sequence: ++sequence };
    const current = authorizationProbe(sampled, signal);
    if (!current || current.sequence !== sequence || current.sequence <= usedSequence)
      throw new Error('STALE_PROBE');
    usedSequence = current.sequence;
    for (const key of ['uid', 'pid', 'startIdentity', 'detachedPgid', 'nonce'])
      if (current[key] !== record[key]) throw new Error('IDENTITY_MISMATCH');
    const markerNow = markerProbe(readMarker(markerPath), signal);
    if (
      !markerNow ||
      markerNow.sha256 !== record.markerSha256 ||
      JSON.stringify(markerNow.value) !== JSON.stringify(marker)
    )
      throw new Error('MARKER_MISMATCH');
    const argument = `--user-data-dir=${expectedProfile}`;
    if (!raw.args.split(/\s+/).includes(argument) || !expectedProfile.includes(record.nonce))
      throw new Error('ARGV_MISMATCH');
    const members = groupMembers(record.detachedPgid);
    if (
      !members.some((row) => row.pid === record.pid) ||
      members.some((row) => row.uid !== record.uid || row.detachedPgid !== record.detachedPgid)
    )
      throw new Error('GROUP_MISMATCH');
    if (victim) {
      const observed = probeProcess(victim.pid);
      for (const key of ['uid', 'pid', 'startIdentity', 'detachedPgid'])
        if (observed[key] !== victim[key]) throw new Error('VICTIM_MISMATCH');
      if (observed.uid !== record.uid || observed.detachedPgid !== record.detachedPgid)
        throw new Error('VICTIM_GROUP');
    }
    return {
      sequence,
      expected: record,
      observed: current,
      members,
      target: victim ? victim.pid : -record.detachedPgid,
    };
  };
  const signal = (name, victim) => {
    const attempt = { signal: name, at: Date.now(), disposition: 'ambiguous' };
    state.terminationAttempts.push(attempt);
    try {
      const proof = authorize(name, victim);
      process.kill(proof.target, name);
      Object.assign(attempt, proof, { disposition: 'sent' });
      return true;
    } catch {
      stopped = true;
      state.ownership = 'ambiguous';
      fail('SIGNAL_AUTHORIZATION_FAILED');
      return false;
    }
  };
  const empty = () => {
    try {
      return !child.pid || groupMembers(child.pid).length === 0;
    } catch {
      fail('GROUP_OBSERVATION_FAILED');
      return false;
    }
  };
  const poll = async (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !(state.closed && empty())) await delay(25);
    return state.closed && empty();
  };
  const terminate = async () => {
    if (state.closed && empty()) return true;
    if (!signal('SIGTERM')) return false;
    if (await poll(1000)) return true;
    if (!signal('SIGKILL')) return false;
    return poll(250);
  };
  timer = setTimeout(() => {
    state.timedOut = true;
    fail('TIMEOUT');
    void terminate().finally(resolveClose);
  }, timeoutMs);
  const finalize = async () => {
    if (finalized) return state;
    finalized = true;
    clearTimeout(timer);
    let closed = state.closed && empty();
    if (!closed && !stopped && record) closed = await terminate();
    if (!closed) {
      state.ownership = 'ambiguous';
      fail('UNCONFIRMED_CLOSURE');
    }
    let markerValid = false;
    try {
      markerValid = readMarker(markerPath).sha256 === record?.markerSha256;
    } catch {}
    state.cleanup = {
      confirmedClosed: closed,
      markerValid,
      leftovers: closed && markerValid ? [] : [canonicalFixtureRoot, expectedProfile],
    };
    child.stdout.off('data', consume);
    child.stderr.off('data', consume);
    child.stdout.destroy();
    child.stderr.destroy();
    child.off('error', onError);
    child.off('close', onClose);
    if (log) await new Promise((done) => log.end(done));
    state.finalized = true;
    state.finalization = {
      listenersDisposed: true,
      streamsClosed: true,
      timerCleared: true,
      logClosed: !log || log.writableFinished,
    };
    state.status =
      !state.firstError &&
      !state.timedOut &&
      state.closed &&
      state.code === 0 &&
      !state.signal &&
      closed &&
      markerValid
        ? 'pass'
        : 'fail';
    const resultPath = join(evidence, 'result.json');
    try {
      state.result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : null;
    } catch {
      fail('INVALID_HOST_RESULT');
      state.status = 'fail';
    }
    writeFileSync(join(evidence, 'launcher-result.json'), JSON.stringify(state, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
    return state;
  };
  const completion = closePromise.then(finalize);
  return {
    child,
    launched: Date.now(),
    get output() {
      return output;
    },
    get mainPid() {
      return record?.pid;
    },
    state,
    profile: { userData: expectedProfile },
    record: () => record,
    completion,
    terminate: async () => {
      const result = await terminate();
      resolveClose();
      await completion;
      return result;
    },
    captureVictim(pid) {
      const value = probeProcess(pid);
      if (!record || value.uid !== record.uid || value.detachedPgid !== record.detachedPgid)
        throw new Error('UNOWNED_VICTIM');
      return Object.freeze(value);
    },
    crash(victim) {
      return signal('SIGKILL', victim);
    },
  };
}
