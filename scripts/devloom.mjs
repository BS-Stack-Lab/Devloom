import { cpSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  selectDevelopmentProfile,
  developmentProfile,
  developmentLocation,
  developmentArguments,
} from './developmentProfile.mjs';
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
  try {
    const selection = selectDevelopmentProfile(process.argv.slice(3));
    developmentLocation(root, selection.id);
    prepare();
    const profile = developmentProfile(root, selection.id);
    const { buildLocalArtifact } = await import('./localExtensionArtifact.mjs');
    const { ensureLocalExtension, localEnvironment } = await import('./localExtensionInstall.mjs');
    const installation = await ensureLocalExtension(root, profile, buildLocalArtifact(root));
    process.stdout.write(
      `${JSON.stringify({
        developmentProfile: profile.id,
        status: profile.created ? 'created' : 'reused',
        userData: profile.userData,
        extensions: profile.extensions,
        notice:
          'Ordinary Workbench; owned offline extension installation verified. Native restore/focus preferences apply.',
        installation: installation.status,
      })}\n`,
    );
    await run(
      resolve(upstream, 'scripts/code.sh'),
      developmentArguments(root, profile, selection.workspace),
      upstream,
      localEnvironment(root),
    );
  } catch (error) {
    process.stderr.write(`Development start failed: ${String(error.message).slice(0, 400)}\n`);
    process.exitCode = 1;
  }
} else throw new Error('Use check, prepare, build, or start');
