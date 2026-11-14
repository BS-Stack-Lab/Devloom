export function isReadOnly(args: string[]): boolean {
  let offset = 0;
  while (args[offset] === '-c') {
    if (!args[offset + 1] || !/^[A-Za-z0-9.-]+=/.test(args[offset + 1]))
      throw new Error('Invalid Git option');
    offset += 2;
  }
  const command = args[offset];
  const rest = args.slice(offset + 1);
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
    throw new Error(
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
    throw new Error('Unsupported Git command or global option.');
  return readonly;
}
