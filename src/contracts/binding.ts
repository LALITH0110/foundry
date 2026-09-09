import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Capability } from './artifact.js';

export const tenantBindingSchema = z
  .object({
    id: z.string().min(1),
    origin: z.string().url(),
    entryPath: z.string().startsWith('/'),
    frameTitle: z.string().min(1),
    reviewedFor: z.object({ vendor: z.string(), version: z.string() }).strict(),
  })
  .strict();
export type TenantBinding = z.infer<typeof tenantBindingSchema>;

export async function loadTenantBinding(path: string): Promise<TenantBinding> {
  return tenantBindingSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

export function bindingTarget(binding: TenantBinding): string {
  return new URL(binding.entryPath, binding.origin).toString();
}

export function assertTenantBindingCompatible(capability: Capability, binding: TenantBinding): void {
  if (binding.reviewedFor.vendor !== capability.vendor) {
    throw new Error(
      `Tenant binding ${binding.id} was reviewed for ${binding.reviewedFor.vendor}, not ${capability.vendor}`,
    );
  }
  if (!capability.compatibleVersions.includes(binding.reviewedFor.version)) {
    throw new Error(
      `Tenant binding ${binding.id} version ${binding.reviewedFor.version} is outside the artifact compatibility set`,
    );
  }
}
