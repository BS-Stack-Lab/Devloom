export type Method = 'hello' | 'echo' | 'delay' | 'shutdown';
export type Hello = {
  protocolMajor: number;
  protocolMinor: number;
  build: string;
  features: string[];
};
export const FEATURES = ['echo', 'delay', 'cancel', 'shutdown'];
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
export function validId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 2147483647;
}
export function validateParams(method: Method, params: unknown): void {
  if (!object(params)) throw new Error('InvalidParams');
  if (method === 'hello') {
    if (
      !keys(params, ['protocolMajor', 'protocolMinor']) ||
      params.protocolMajor !== 1 ||
      params.protocolMinor !== 0
    )
      throw new Error('InvalidParams');
  } else if (method === 'shutdown') {
    if (!keys(params, [])) throw new Error('InvalidParams');
  } else if (
    !keys(params, method === 'delay' ? ['text', 'delayMs'] : ['text']) ||
    typeof params.text !== 'string' ||
    Buffer.byteLength(params.text) > 8192 ||
    (method === 'delay' &&
      (typeof params.delayMs !== 'number' ||
        !Number.isInteger(params.delayMs) ||
        params.delayMs < 0 ||
        params.delayMs > 10000))
  )
    throw new Error('InvalidParams');
}
export function response(value: unknown): {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
} {
  if (
    !object(value) ||
    !keys(value, ['jsonrpc', 'id', 'result', 'error']) ||
    value.jsonrpc !== '2.0' ||
    !validId(value.id) ||
    'result' in value === 'error' in value
  )
    throw new Error('InvalidResponse');
  if (
    'error' in value &&
    (!object(value.error) ||
      !keys(value.error, ['code', 'message']) ||
      !Number.isInteger(value.error.code) ||
      typeof value.error.message !== 'string' ||
      value.error.message.length > 256)
  )
    throw new Error('InvalidResponse');
  return value as { id: number; result?: unknown; error?: { code: number; message: string } };
}
export function validateResult(method: Method, value: unknown): void {
  if (method === 'shutdown') {
    if (value !== null) throw new Error('InvalidResult');
  } else if (method === 'hello') {
    if (
      !object(value) ||
      !keys(value, ['protocolMajor', 'protocolMinor', 'build', 'features']) ||
      value.protocolMajor !== 1 ||
      value.protocolMinor !== 0 ||
      typeof value.build !== 'string' ||
      !value.build.length ||
      value.build.length > 128 ||
      !Array.isArray(value.features) ||
      JSON.stringify(value.features) !== JSON.stringify(FEATURES)
    )
      throw new Error('ProtocolMismatch');
  } else if (
    !object(value) ||
    !keys(value, ['text']) ||
    typeof value.text !== 'string' ||
    Buffer.byteLength(value.text) > 8192
  )
    throw new Error('InvalidResult');
}
