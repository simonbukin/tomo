export function mockApi<T extends object>(actual: T, rpc: (method: string, params?: unknown) => Promise<unknown>): T {
  return { ...actual, rpc, rpcParsed: (method: string, schema: { parse: (v: unknown) => unknown }, params?: unknown) => rpc(method, params).then((v) => schema.parse(v)) };
}
