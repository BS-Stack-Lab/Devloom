import { spawn, execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  createWriteStream,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare, root, upstream } from './upstream.mjs';
export function createEvidenceDirectory(parent) {
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, 'session-'));
}
async function main() {
  prepare();
  if (
    !existsSync(resolve(upstream, 'out/vs/code/electron-main/main.js')) ||
    !existsSync(resolve(upstream, '.build/electron'))
  )
    throw new Error('Build upstream and prepare Electron before host smoke');
  const evidence = createEvidenceDirectory(
    resolve(process.env.DEVLOOM_EVIDENCE_DIR || join(root, '.local-evidence/extension-host')),
  );
  const temporary = mkdtempSync(join(tmpdir(), 'devloom-host-'));
  const workspace = join(temporary, 'workspace');
  const userData = join(temporary, 'profile');
  const extensions = join(temporary, 'extensions');
  const raw = createWriteStream(join(evidence, 'extension-host.log'), { flags: 'wx' });
  let timedOut = false;
  let child;
  let timer;
  let escalation;
  try {
    for (const dir of [workspace, extensions, join(userData, 'User')])
      mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(userData, 'User/settings.json'),
      JSON.stringify({
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
        'extensions.autoCheckUpdates': false,
        'extensions.autoUpdate': false,
        'chat.disableAIFeatures': true,
        'security.workspace.trust.enabled': false,
      }),
    );
    const git = (args) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
    git(['init']);
    git(['config', 'user.name', 'Devloom Local Fixture']);
    git(['config', 'user.email', 'fixture@invalid.local']);
    writeFileSync(join(workspace, 'fixture.ts'), 'baseline\n');
    git(['add', 'fixture.ts']);
    git(['commit', '-m', 'fixture']);
    writeFileSync(join(workspace, 'fixture.ts'), 'changed\n');
    const args = [
      workspace,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${extensions}`,
      `--extensionDevelopmentPath=${join(root, 'extensions/devloom-bootstrap')}`,
      `--extensionTestsPath=${join(root, 'dist/tests/extensionHost.js')}`,
      '--disable-telemetry',
      '--disable-updates',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      ...[
        'GitHub.copilot-chat',
        'GitHub.copilot',
        'vscode.github-authentication',
        'vscode.microsoft-authentication',
      ].map((id) => `--disable-extension=${id}`),
    ];
    child = spawn(join(upstream, 'scripts/code.sh'), args, {
      cwd: upstream,
      detached: true,
      shell: false,
      env: {
        ...process.env,
        VSCODE_DEV: '1',
        VSCODE_SKIP_PRELAUNCH: '1',
        DEVLOOM_EVIDENCE_DIR: evidence,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(raw, { end: false });
    child.stderr.pipe(raw, { end: false });
    const terminate = (signal) => {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch {}
      }
    };
    timer = setTimeout(() => {
      timedOut = true;
      terminate('SIGTERM');
      escalation = setTimeout(() => terminate('SIGKILL'), 1000);
    }, 90000);
    const exit = await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolveExit({ code, signal }));
    });
    const resultPath = join(evidence, 'result.json');
    const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : null;
    writeFileSync(
      join(evidence, 'launcher-result.json'),
      JSON.stringify(
        { ...exit, timedOut, resultPath, temporary, childPid: child.pid, result },
        null,
        2,
      ),
    );
    if (timedOut || exit.code !== 0 || result?.status !== 'pass')
      throw new Error(`Extension host failed; evidence: ${evidence}`);
    process.stdout.write(`Extension host passed: ${resultPath}\n`);
  } finally {
    clearTimeout(timer);
    clearTimeout(escalation);
    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
    raw.end();
    rmSync(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
