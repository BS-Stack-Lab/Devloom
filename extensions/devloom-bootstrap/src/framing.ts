import { TextDecoder } from 'node:util';
export const MAX_BODY = 65536;
export const MAX_HEADER = 1024;
export function encode(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > MAX_BODY) throw new Error('OversizeBody');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}
export class FrameDecoder {
  private buffer = Buffer.alloc(0);
  private length: number | undefined;
  push(chunk: Buffer): unknown[] {
    const results: unknown[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (this.length === undefined) {
        this.buffer = Buffer.concat([this.buffer, chunk.subarray(offset, ++offset)]);
        if (this.buffer.length > MAX_HEADER) throw new Error('OversizeHeader');
        if (!this.buffer.subarray(-4).equals(Buffer.from('\r\n\r\n'))) continue;
        if (this.buffer.some((byte) => byte > 127)) throw new Error('InvalidHeader');
        const header = this.buffer.toString('ascii');
        if (!/^Content-Length: (0|[1-9][0-9]*)\r\n\r\n$/.test(header))
          throw new Error('InvalidHeader');
        this.length = Number(header.slice(16, -4));
        if (this.length < 1 || this.length > MAX_BODY) throw new Error('OversizeBody');
        this.buffer = Buffer.alloc(0);
      } else {
        const take = Math.min(this.length - this.buffer.length, chunk.length - offset);
        this.buffer = Buffer.concat([this.buffer, chunk.subarray(offset, offset + take)]);
        offset += take;
        if (this.buffer.length !== this.length) continue;
        results.push(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.buffer)));
        this.buffer = Buffer.alloc(0);
        this.length = undefined;
      }
    }
    return results;
  }
  end(): void {
    if (this.length !== undefined || this.buffer.length) throw new Error('TruncatedFrame');
  }
}
