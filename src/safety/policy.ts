import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const policySchema = z
  .object({
    version: z.string(),
    allowedOrigins: z.array(z.string().url()),
    allowedPathPrefixes: z.array(z.string().startsWith('/')),
    blockedPathPrefixes: z.array(z.string().startsWith('/')),
    allowedActions: z.array(z.enum(['navigate', 'click', 'fill', 'select', 'read', 'check'])),
    blockedControlNames: z.array(z.string()),
    maxActions: z.number().int().positive(),
  })
  .strict();
export type Policy = z.infer<typeof policySchema>;

export async function loadPolicy(path = 'config/policy.json'): Promise<Policy> {
  return policySchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

export class PolicyError extends Error {
  readonly code = 'POLICY_DENIED';
}

function pathMatchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}

export function assertUrlAllowed(rawUrl: string, policy: Policy): void {
  const url = new URL(rawUrl);
  if (!policy.allowedOrigins.includes(url.origin)) throw new PolicyError(`Origin is not allowed: ${url.origin}`);
  if (!policy.allowedPathPrefixes.some((prefix) => pathMatchesPrefix(url.pathname, prefix)))
    throw new PolicyError(`Path is not allowed: ${url.pathname}`);
  if (policy.blockedPathPrefixes.some((prefix) => pathMatchesPrefix(url.pathname, prefix)))
    throw new PolicyError(`Path is blocked by policy: ${url.pathname}`);
}

export function assertActionAllowed(kind: string, targetName: string | undefined, policy: Policy): void {
  if (!policy.allowedActions.includes(kind as never)) throw new PolicyError(`Action type is not allowed: ${kind}`);
  if (targetName && policy.blockedControlNames.includes(targetName))
    throw new PolicyError(`Control is blocked by policy: ${targetName}`);
}
