class GitPolicyError extends Error {
  readonly code = 'DevloomGitPolicy';
}
export function isReadOnly(args: string[]): boolean {
  let offset = 0;
  const overrides: string[] = [];
  while (args[offset] === '-c') {
    if (!args[offset + 1] || !/^[A-Za-z0-9.-]+=/.test(args[offset + 1]))
      throw new GitPolicyError('Invalid Git option');
    overrides.push(args[offset + 1]);
    offset += 2;
  }
  const command = args[offset];
  const rest = args.slice(offset + 1);
  for (const override of overrides) {
    const separator = override.indexOf('=');
    const key = override.slice(0, separator).toLowerCase();
    const value = override.slice(separator + 1);
    const safe =
      (key === 'i18n.logoutputencoding' && /^utf-8$/i.test(value)) ||
      (key === 'user.useconfigonly' && /^(true|false|0|1)$/i.test(value)) ||
      (key === 'core.excludesfile' &&
        command === 'check-ignore' &&
        value.startsWith('/') &&
        !/[\0\r\n]/.test(value));
    if (!safe)
      throw new GitPolicyError(
        'Unsupported Git configuration override. Remove repository-routing configuration before retrying.',
      );
  }
  if (
    rest.some(
      (arg) =>
        /^(--git-dir|--work-tree|--namespace|--separate-git-dir)(=|$)/.test(arg) &&
        !(command === 'rev-parse' && arg === '--git-dir'),
    )
  )
    throw new GitPolicyError('Unsupported Git repository routing option.');
  if (
    command === 'clone' &&
    rest.some(
      (arg) => arg === '-c' || arg.startsWith('-c') || /^(--config|--config-env)(=|$)/.test(arg),
    )
  )
    throw new GitPolicyError('Unsupported clone configuration override.');

  const read = new Set([
    'status',
    'rev-parse',
    'rev-list',
    'show',
    'log',
    'diff',
    'diff-tree',
    'diff-index',
    'ls-files',
    'ls-tree',
    'cat-file',
    'check-ignore',
    'check-attr',
    'for-each-ref',
    'symbolic-ref',
    'merge-base',
    'blame',
    'shortlog',
    'describe',
    'count-objects',
    'check-ref-format',
    'ls-remote',
    'version',
  ]);
  let readonly = read.has(command);
  if (command === 'symbolic-ref')
    readonly =
      rest.filter((arg) => !arg.startsWith('-')).length === 1 &&
      rest
        .filter((arg) => arg.startsWith('-'))
        .every((arg) => ['--short', '--quiet', '-q', '--no-recurse'].includes(arg));
  if (command === 'merge-file') readonly = rest.includes('-p') || rest.includes('--stdout');
  if (command === 'config')
    readonly =
      rest.some((arg) =>
        ['--get', '--get-all', '--get-regexp', '--list', '-l', '--get-urlmatch'].includes(arg),
      ) &&
      !rest.some((arg) =>
        [
          '--add',
          '--unset',
          '--unset-all',
          '--replace-all',
          '--rename-section',
          '--remove-section',
          '--edit',
        ].includes(arg.split('=')[0]),
      );
  if (command === 'stash') readonly = ['list', 'show'].includes(rest[0]);
  if (command === 'reflog')
    readonly = !rest.some((arg) => ['delete', 'expire', 'drop', 'write'].includes(arg));
  if (command === 'worktree') readonly = rest[0] === 'list';
  if (
    command === 'config' &&
    !readonly &&
    rest.some(
      (arg) =>
        ['--global', '--system', '--file', '-f'].includes(arg.split('=')[0]) || /^-f.+/.test(arg),
    )
  )
    throw new GitPolicyError(
      'Global Git configuration requires explicit configuration outside this operation.',
    );
  if (command === 'hash-object') readonly = !rest.some((arg) => /^-[^-]*w/.test(arg));
  if (command === 'remote')
    readonly =
      rest.length === 0 ||
      rest.every((arg) => ['-v', '--verbose'].includes(arg)) ||
      (['get-url', 'show'].includes(rest[0]) && (rest[0] !== 'show' || rest.includes('-n')));
  if (command === 'branch')
    readonly = rest.every((arg) =>
      /^(--list|--show-current|--all|--remotes|--verbose|-a|-r|-v|-vv|--format=.*)$/.test(arg),
    );
  if (rest.some((arg) => arg === '--output' || arg.startsWith('--output='))) readonly = false;
  if (
    command === 'config' &&
    !readonly &&
    rest.some((arg) =>
      /^(core\.(worktree|bare|repositoryformatversion)|extensions\.(worktreeconfig|refstorage)|include\.path|includeif\..*\.path)$/i.test(
        arg,
      ),
    )
  )
    throw new GitPolicyError(
      'Repository-routing Git configuration cannot be changed by this operation.',
    );
  const mutable = new Set([
    'init',
    'clone',
    'apply',
    'hash-object',
    'add',
    'rm',
    'update-index',
    'checkout',
    'commit',
    'rebase',
    'branch',
    'mv',
    'update-ref',
    'merge',
    'tag',
    'worktree',
    'push',
    'clean',
    'reset',
    'restore',
    'remote',
    'fetch',
    'pull',
    'cherry-pick',
    'stash',
    'config',
    'symbolic-ref',
    'reflog',
    'merge-file',
  ]);
  if (!readonly && !mutable.has(command))
    throw new GitPolicyError('Unsupported Git command or global option.');
  return readonly;
}

export function validateEnvironment(environment: NodeJS.ProcessEnv): void {
  const routing = new Set([
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE',
    'GIT_QUARANTINE_PATH',
    'GIT_SHALLOW_FILE',
    'GIT_GRAFT_FILE',
    'GIT_CEILING_DIRECTORIES',
    'GIT_DISCOVERY_ACROSS_FILESYSTEM',
    'GIT_IMPLICIT_WORK_TREE',
    'GIT_SUPER_PREFIX',
    'GIT_CONFIG',
    'GIT_CONFIG_SYSTEM',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_PARAMETERS',
  ]);
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    const key = name.toUpperCase();
    if (
      routing.has(key) ||
      /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key) ||
      (key === 'GIT_CONFIG_COUNT' && value !== '0')
    )
      throw new GitPolicyError(
        `Unsupported Git routing environment: ${name}. Remove the override and retry.`,
      );
  }
}
