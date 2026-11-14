import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameDecoder, encode } from '../extensions/devloom-bootstrap/src/framing';
import {
  response,
  validateResult,
  validateParams,
} from '../extensions/devloom-bootstrap/src/protocol';
test('fragmented and combined UTF-8 frames preserve bytes', () => {
  const value = { text: '한글 e\u0301 👨‍👩‍👧‍👦\n' };
  const decoder = new FrameDecoder();
  const wire = Buffer.concat([encode(value), encode({ text: '' })]);
  const results: unknown[] = [];
  for (const byte of wire) results.push(...decoder.push(Buffer.from([byte])));
  decoder.end();
  assert.deepEqual(results, [value, { text: '' }]);
  assert.deepEqual(new FrameDecoder().push(wire), results);
});
test('framing rejects malformed, excessive and incomplete data', () => {
  const cases = [
    'Content-Length: -1\r\n\r\n',
    'Content-Length: 65537\r\n\r\n',
    'Content-Length: 1\r\nContent-Length: 1\r\n\r\n',
    'x'.repeat(1025),
    'Content-Length: 0\r\n\r\n',
    'Content-Length: 01\r\n\r\n',
  ];
  for (const wire of cases) assert.throws(() => new FrameDecoder().push(Buffer.from(wire)));
  assert.throws(() =>
    new FrameDecoder().push(
      Buffer.concat([Buffer.from('Content-Length: 1\r\n\r\n'), Buffer.from([255])]),
    ),
  );
  assert.throws(() => new FrameDecoder().push(Buffer.from('Content-Length: 1\r\n\r\nx')));
  assert.throws(() =>
    new FrameDecoder().push(
      Buffer.concat([Buffer.from([195]), Buffer.from('ontent-Length: 1\r\n\r\n1')]),
    ),
  );
  const partial = new FrameDecoder();
  partial.push(Buffer.from('Content-Length: 5\r\n\r\n{}'));
  assert.throws(() => partial.end());
  const limit = { text: 'x'.repeat(65525) };
  assert.equal(Buffer.byteLength(JSON.stringify(limit)), 65536);
  assert.deepEqual(new FrameDecoder().push(encode(limit)), [limit]);
  assert.throws(() => encode({ text: 'x'.repeat(65526) }));
});
test('response and method schemas validate exact envelopes and ranges', () => {
  for (const value of [
    [],
    {},
    { jsonrpc: '2.0', id: 0, result: null },
    { jsonrpc: '2.0', id: 1, result: null, error: {} },
    { jsonrpc: '2.0', id: 1, error: { code: 'x', message: '' } },
  ])
    assert.throws(() => response(value));
  assert.throws(() =>
    validateResult('hello', { protocolMajor: 99, protocolMinor: 0, build: 'x', features: [] }),
  );
  assert.throws(() => validateResult('echo', { text: '', extra: true }));
  validateParams('echo', { text: '한'.repeat(2730) + 'xx' });
  assert.throws(() => validateParams('echo', { text: '한'.repeat(2731) }));
  for (const delayMs of [-1, 10001, 1.5, '0'])
    assert.throws(() => validateParams('delay', { text: '', delayMs }));
  validateParams('delay', { text: '', delayMs: 10000 });
});
