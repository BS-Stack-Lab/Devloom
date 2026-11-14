import { spawn } from 'node:child_process';
const child = spawn(process.argv[2], [], { stdio: ['pipe', 'ignore', 'ignore'], shell: false });
child.once('spawn', () => {
  process.stdout.write(`${child.pid}\n`);
  child.stdin.write('Content-Length: 50\r\n\r\n{');
});
setInterval(() => {}, 1000);
