import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function processTree() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,comm='], {
    encoding: 'utf8',
    timeout: 1000,
    maxBuffer: 1024 * 1024,
  })
    .trim()
    .split('\n')
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      assert.ok(match);
      return {
        pid: Number(match[1]),
        parent: Number(match[2]),
        group: Number(match[3]),
        command: match[4],
      };
    });
}

export const delay = (ms) => new Promise((done) => setTimeout(done, ms));
export async function waitFor(label, inspect, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await inspect();
    if (value) return value;
    await delay(75);
  }
  throw new Error(`Timeout: ${label}`);
}
export function loopback(value) {
  const url = new URL(value);
  assert.ok(['ws:', 'http:'].includes(url.protocol));
  assert.ok(['127.0.0.1', '[::1]'].includes(url.hostname), 'Literal loopback required');
  assert.ok(!url.username && !url.password && !url.search && !url.hash);
  assert.ok(Number(url.port) > 0 && Number(url.port) <= 65535);
  return url;
}
export function discoverEndpoint(log, file, launched) {
  const lines = log.split('\n').filter((line) => line.includes('DevTools listening on'));
  assert.ok(lines.length, 'Missing current-launch endpoint');
  const endpoints = [
    ...new Set(
      lines.map((line) => {
        const match = line.match(/^DevTools listening on (ws:\/\/\S+)\s*$/);
        assert.ok(match, 'Malformed current-launch endpoint');
        const url = loopback(match[1]);
        assert.match(url.pathname, /^\/devtools\/browser\/[a-zA-Z0-9-]+$/);
        return url.href;
      }),
    ),
  ];
  assert.equal(endpoints.length, 1, 'Ambiguous current-launch endpoints');
  const endpoint = endpoints[0];
  if (file && existsSync(file)) {
    const stat = lstatSync(file);
    assert.ok(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.uid === process.getuid() &&
        !(stat.mode & 0o022) &&
        stat.size < 4096 &&
        stat.mtimeMs >= launched,
      'Unsafe or stale DevToolsActivePort',
    );
    const parts = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(parts.length, 2);
    const url = new URL(endpoint);
    assert.equal(parts[0], url.port, 'Conflicting debug port');
    assert.equal(parts[1], url.pathname, 'Conflicting debug endpoint');
  }
  return endpoint;
}
export function verifyListeners(records, mainPid, group, processGroup) {
  let pid;
  const listeners = [];
  for (const line of records.trim().split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    if (line.startsWith('n')) {
      assert.ok(pid === mainPid && processGroup(pid) === group, 'Foreign debug listener');
      assert.match(line.slice(1), /^(127\.0\.0\.1|\[::1\]):[0-9]+$/, 'Nonloopback debug listener');
      listeners.push({ pid, address: line.slice(1) });
    }
  }
  assert.ok(listeners.length, 'Missing debug listener ownership');
  return listeners;
}
export async function ownedTarget(host, profile, nonce) {
  const endpoint = discoverEndpoint(
    host.output,
    join(profile.userData, 'DevToolsActivePort'),
    host.launched,
  );
  const browser = loopback(endpoint);
  const records = execFileSync(
    '/usr/sbin/lsof',
    ['-nP', `-iTCP:${browser.port}`, '-sTCP:LISTEN', '-Fpn'],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 },
  );
  const tree = processTree();
  const processGroup = (pid) => tree.find((row) => row.pid === pid)?.group;
  const listeners = verifyListeners(records, host.mainPid, host.child.pid, processGroup);
  const response = await fetch(`http://${browser.host}/json/list`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.ok, true);
  const targets = await response.json();
  const target = selectTarget(targets, nonce, browser);
  return { endpoint, listeners, target };
}
export function selectTarget(targets, nonce, browser) {
  assert.ok(Array.isArray(targets));
  const selected = targets.filter(
    (target) =>
      target.type === 'page' && typeof target.title === 'string' && target.title.includes(nonce),
  );
  assert.equal(selected.length, 1, 'Missing or ambiguous nonce workbench target');
  const target = selected[0];
  const url = loopback(target.webSocketDebuggerUrl);
  assert.equal(url.host, browser.host);
  assert.match(url.pathname, /^\/devtools\/page\/[A-Za-z0-9-]+$/);
  return target;
}
export class CDP {
  constructor(socket, timeout = 5000) {
    this.socket = socket;
    this.timeout = timeout;
    this.sequence = 0;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      try {
        const response = JSON.parse(event.data);
        const pending = this.pending.get(response.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(response.id);
        if (response.error) pending.reject(new Error(JSON.stringify(response.error)));
        else pending.resolve(response.result);
      } catch (error) {
        this.close(error);
      }
    });
    socket.addEventListener('close', () => this.close(new Error('CDP disconnected')));
    socket.addEventListener('error', () => this.close(new Error('CDP socket error')));
  }
  static async connect(url) {
    loopback(url);
    const socket = new WebSocket(url);
    const client = new CDP(socket);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        client.close();
        reject(new Error('CDP connect timeout'));
      }, 5000);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('CDP connect failed'));
        },
        { once: true },
      );
    });
    return client;
  }
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (this.socket.readyState !== 1) return reject(new Error('CDP unavailable'));
      const id = ++this.sequence;
      const timer = setTimeout(() => this.close(new Error(`CDP timeout: ${method}`)), this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close(error = new Error('CDP closed')) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    if (this.socket.readyState < 2) this.socket.close();
  }
  async evaluate(expression) {
    const response = await this.call('Runtime.evaluate', { expression, returnByValue: true });
    assert.ok(!response.exceptionDetails, JSON.stringify(response.exceptionDetails));
    return response.result.value;
  }
  async modal() {
    return this.evaluate(
      `(() => { const dialogs = [...document.querySelectorAll('.monaco-dialog-box')].filter(e => e.getBoundingClientRect().width); return dialogs.map(d => ({ text: d.innerText, buttons: [...d.querySelectorAll('button,.monaco-button')].map(b => { const r = b.getBoundingClientRect(); return { label: b.innerText.replace(/&/g,'').trim(), x:r.x+r.width/2, y:r.y+r.height/2, width:r.width, height:r.height }; }) })); })()`,
    );
  }
  async screenshot(path) {
    const value = await this.call('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path, Buffer.from(value.data, 'base64'), { flag: 'wx', mode: 0o600 });
  }
  async click(button) {
    assert.ok(button.width > 0 && button.height > 0);
    for (const type of ['mousePressed', 'mouseReleased'])
      await this.call('Input.dispatchMouseEvent', {
        type,
        x: button.x,
        y: button.y,
        button: 'left',
        clickCount: 1,
      });
  }
  async choice(label, expectedText, evidence, stage, binding) {
    const modal = await waitFor('native warning', async () => {
      const all = await this.modal();
      assert.ok(all.length <= 1);
      return all[0];
    });
    assert.ok(modal.text.includes(expectedText), `Unexpected native modal: ${modal.text}`);
    for (const expected of ['Save All  Commit Changes', 'Commit Changes', 'Cancel'])
      assert.ok(
        modal.buttons.some((b) => b.label === expected),
        JSON.stringify(modal),
      );
    const matches = modal.buttons.filter((button) => button.label === label.replace(/&/g, ''));
    assert.equal(matches.length, 1);
    await this.screenshot(join(evidence, `${stage}-before.png`));
    writeFileSync(
      join(evidence, `${stage}-modal.json`),
      JSON.stringify({ ...binding, modal, label, clicked: Date.now() }, null, 2),
      { flag: 'wx', mode: 0o600 },
    );
    await this.click(matches[0]);
    await waitFor('warning disappearance', async () =>
      (await this.modal()).every((modal) => !modal.text.includes(expectedText)),
    );
    await this.screenshot(join(evidence, `${stage}-after.png`));
  }
  async focusInput(name, nonce) {
    const inputs = await this.evaluate(
      `[...document.querySelectorAll('.scm-editor .monaco-editor[data-uri]')].map(e => { const r=e.getBoundingClientRect(); return {uri:decodeURIComponent(decodeURIComponent(e.getAttribute('data-uri'))), x:r.x+20,y:r.y+12,width:r.width,height:r.height}; }).filter(e=>e.width>0)`,
    );
    const selected = inputs.filter(
      (input) => input.uri.endsWith('/' + name) && input.uri.includes(nonce),
    );
    assert.equal(selected.length, 1, JSON.stringify(inputs));
    await this.click(selected[0]);
  }
  async key(key, code, modifiers, windowsVirtualKeyCode) {
    for (const type of ['keyDown', 'keyUp'])
      await this.call('Input.dispatchKeyEvent', {
        type,
        key,
        code,
        modifiers,
        windowsVirtualKeyCode,
      });
  }
}
