import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage } from "node:http";

export interface RequestContext {
  employeeApiKey?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentEmployeeApiKey(fallback = ""): string {
  return storage.getStore()?.employeeApiKey || fallback;
}

export function employeeApiKeyFromHeaders(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();

  const header = req.headers["x-employee-api-key"];
  if (Array.isArray(header)) return header[0]?.trim();
  return header?.trim();
}
