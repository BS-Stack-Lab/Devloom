import * as vscode from 'vscode';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  existsSync,
} from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StorageCases } from './storageCoherenceCases';

type Request = {
  nonce: string;
  activation: string;
  window: string;
  stage: string;
  sequence: number;
  action: 'burst' | 'arm' | 'write' | 'read' | 'foreign' | 'quit' | 'close';
  generation: number;
  deleted: boolean;
};
type Capability = {
  schema: number;
  contract: number;
  type: string;
  encryption: boolean;
  provider: string;
  platform: string;
  globalStorageHome: string | null;
};

export function validateControl(
  value: Request,
  nonce: string,
  activation: string,
  window: string,
  sequence: number,
): boolean {
  return (
    Object.keys(value).sort().join(',') ===
      'action,activation,deleted,generation,nonce,sequence,stage,window' &&
    value.nonce === nonce &&
    value.activation === activation &&
    value.window === window &&
    /^[a-z0-9-]{1,64}$/.test(value.stage) &&
    value.sequence === sequence + 1 &&
    ['burst', 'arm', 'write', 'read', 'foreign', 'quit', 'close'].includes(value.action) &&
    Number.isInteger(value.generation) &&
    value.generation >= 0 &&
    value.generation <= 64 &&
    typeof value.deleted === 'boolean'
  );
}

export function readControl(path: string): Request {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let request: Request;
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid!() ||
      stat.size > 2048 ||
      (stat.mode & 0o777) !== 0o600
    )
      throw new Error('UNSAFE_CONTROL');
    request = JSON.parse(readFileSync(descriptor, 'utf8')) as Request;
  } finally {
    closeSync(descriptor);
  }
  return request;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const fixture = JSON.parse(readFileSync(join(context.extensionPath, 'fixture.json'), 'utf8')) as {
    nonce: string;
    channel: string;
    workspaces: Record<string, string>;
    profile: string;
  };
  if (
    !/^[a-f0-9]{32}$/.test(fixture.nonce) ||
    !isAbsolute(fixture.channel) ||
    !isAbsolute(fixture.profile)
  )
    throw new Error('INVALID_FIXTURE');
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const window =
    workspace &&
    Object.keys(fixture.workspaces).find(
      (name) => realpathSync(fixture.workspaces[name]) === realpathSync(workspace),
    );
  if (!window || !/^[a-z]$/.test(window)) throw new Error('INVALID_WINDOW');
  const channel = realpathSync(join(fixture.channel, window));
  if (channel !== join(realpathSync(fixture.channel), window)) throw new Error('INVALID_CHANNEL');
  const activation = randomUUID();
  const started = Date.now();
  const mainPid = Number(process.env.VSCODE_PID);
  if (!Number.isSafeInteger(mainPid) || mainPid < 2) throw new Error('INVALID_MAIN');
  const metadata = {
    nonce: fixture.nonce,
    activation,
    window,
    started,
    mainPid,
    extensionHostPid: process.pid,
    workspace: realpathSync(workspace!),
    appName: vscode.env.appName,
  };
  const publish = (name: string, value: object): void => {
    writeFileSync(join(channel, name), `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
  };
  let capability = false;
  try {
    const observed = await vscode.commands.executeCommand<Capability>(
      '_devloom.authStorageCapability',
    );
    capability =
      observed?.schema === 1 &&
      observed.contract === 1 &&
      observed.type === 'persisted' &&
      observed.encryption === true &&
      observed.provider === 'keychain' &&
      observed.platform === 'darwin' &&
      typeof observed.globalStorageHome === 'string' &&
      observed.globalStorageHome.startsWith(`${fixture.profile}/`);
  } catch {
    capability = false;
  }
  publish(`activation-${activation}.json`, {
    ...metadata,
    capability,
    status: capability ? 'pass' : 'fail',
  });
  if (!capability) return;
  const cases = new StorageCases(context.secrets, fixture.nonce);
  context.subscriptions.push(cases);
  let running = false;
  let sequence = 0;
  let stopped = false;
  const poll = async (): Promise<void> => {
    if (stopped || running) return;
    if (Date.now() - started > 240000) {
      stopped = true;
      clearInterval(timer);
      return;
    }
    const path = join(channel, 'request.json');
    if (!existsSync(path)) return;
    const request = readControl(path);
    if (!validateControl(request, fixture.nonce, activation, window, sequence)) return;
    running = true;
    sequence = request.sequence;
    let status = 'pass';
    let data: object = {};
    try {
      if (request.action === 'burst') data = await cases.ownBurst();
      else if (request.action === 'arm') {
        cases.arm(request.generation, request.deleted);
        data = { armed: true };
      } else if (request.action === 'write')
        data = await cases.write(request.generation, request.deleted);
      else if (request.action === 'foreign') data = await cases.foreign();
      else data = await cases.read();
    } catch {
      status = 'fail';
      data = { failure: 'STORAGE_ASSERTION_FAILED' };
    }
    publish(`result-${request.stage}.json`, {
      ...metadata,
      ...request,
      status,
      data,
      observed: Date.now(),
    });
    running = false;
    if (request.action === 'quit' || request.action === 'close') {
      stopped = true;
      clearInterval(timer);
      setTimeout(() => {
        void vscode.commands.executeCommand(
          request.action === 'quit' ? 'workbench.action.quit' : 'workbench.action.closeWindow',
        );
      }, 100);
    }
  };
  const timer = setInterval(() => {
    void poll().catch(() => {
      stopped = true;
      clearInterval(timer);
      publish(`control-failure-${activation}.json`, {
        ...metadata,
        status: 'fail',
        failure: 'CONTROL_REJECTED',
      });
    });
  }, 25);
  context.subscriptions.push({
    dispose: () => {
      stopped = true;
      clearInterval(timer);
    },
  });
}
