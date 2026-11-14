import { FrameDecoder, encode } from '../extensions/devloom-bootstrap/src/framing';
const mode = process.argv[2];
const decoder = new FrameDecoder();
if (mode === 'stubborn') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
process.stdin.on('data', (chunk: Buffer) => {
  for (const value of decoder.push(chunk)) {
    const packet = value as { id?: number; method: string };
    if (packet.method === 'hello') {
      if (mode === 'malformed')
        process.stdout.write(encode({ jsonrpc: '2.0', id: packet.id, result: {}, error: {} }));
      else
        process.stdout.write(
          encode({
            jsonrpc: '2.0',
            id: packet.id,
            result: {
              protocolMajor: mode === 'mismatch' ? 99 : 1,
              protocolMinor: 0,
              build: 'fixture',
              features: ['echo', 'delay', 'cancel', 'shutdown'],
            },
          }),
        );
      if (mode === 'blocked') process.stdin.pause();
    } else if (packet.method === 'shutdown' && mode !== 'stubborn') process.exit(0);
  }
});
process.stdin.on('end', () => {
  if (mode !== 'stubborn') process.exit(0);
});
