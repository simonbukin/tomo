/**
 * Mocks the daemon transport and keeps the boundary parser. A test then drives `rpc` as
 * before, and a fixture still has to be a shape the daemon could really send.
 */
export function mockApi<T extends object>(actual: T, rpc: (method: string, params?: unknown) => Promise<unknown>): T {
  return { ...actual, rpc, rpcParsed: (method: string, schema: { parse: (v: unknown) => unknown }, params?: unknown) => rpc(method, params).then((v) => schema.parse(v)) };
}
