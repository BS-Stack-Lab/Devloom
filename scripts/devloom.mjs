import { cpSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { check, prepare, root, run, upstream } from './upstream.mjs';
const command = process.argv[2];
if (command === 'check') process.stdout.write(`${JSON.stringify(check())}\n`);
else if (command === 'prepare') process.stdout.write(`${JSON.stringify(prepare())}\n`);
else if (command === 'build') {
  await run(resolve(root, 'node_modules/.bin/tsc6'), ['-p', 'tsconfig.json']);
  mkdirSync(resolve(root, 'extensions/devloom-bootstrap/dist'), { recursive: true });
  cpSync(
    resolve(root, 'dist/extensions/devloom-bootstrap/src'),
    resolve(root, 'extensions/devloom-bootstrap/dist'),
    { recursive: true },
  );
} else if (command === 'start') {
  prepare();
  const temporary = mkdtempSync(join(tmpdir(), 'devloom-manual-'));
  mkdirSync(join(temporary, 'profile/User'), { recursive: true });
  writeFileSync(
    join(temporary, 'profile/User/settings.json'),
    JSON.stringify({
      'telemetry.telemetryLevel': 'off',
      'update.mode': 'none',
      'extensions.autoCheckUpdates': false,
      'extensions.autoUpdate': false,
      'chat.disableAIFeatures': true,
    }),
  );
  try {
    await run(
      resolve(upstream, 'scripts/code.sh'),
      [
        `--extensionDevelopmentPath=${resolve(root, 'extensions/devloom-bootstrap')}`,
        `--user-data-dir=${join(temporary, 'profile')}`,
        `--extensions-dir=${join(temporary, 'extensions')}`,
        '--disable-telemetry',
        '--disable-updates',
        ...[
          'GitHub.copilot-chat',
          'GitHub.copilot',
          'vscode.github-authentication',
          'vscode.microsoft-authentication',
        ].map((id) => `--disable-extension=${id}`),
      ],
      upstream,
      { ...process.env, VSCODE_DEV: '1', VSCODE_SKIP_PRELAUNCH: '1' },
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
} else throw new Error('Use check, prepare, build, or start');
