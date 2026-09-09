import type { Capability, Invocation } from '../contracts/artifact.js';

const sensitiveKey =
  /(password|secret|token|cookie|authorization|memberId|member number|full.?name|email|ssn|social.?security|checkNumber|accountSuffix)/i;
const likelyBearer = /Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const formattedSsn = /\b\d{3}-\d{2}-\d{4}\b/g;

export type RedactionContext = { sensitiveValues: string[] };

export function redactionContextFor(capability: Capability, inputs: Invocation): RedactionContext {
  const sensitiveValues = new Set<string>();
  for (const [name, definition] of Object.entries(capability.inputSchema)) {
    if (!definition.sensitive || !(name in inputs)) continue;
    const value = inputs[name as keyof Invocation];
    sensitiveValues.add(String(value));
    if (definition.type === 'integer') {
      const display = (Number(value) / 100).toFixed(2);
      sensitiveValues.add(display);
      sensitiveValues.add(`$${display}`);
    }
  }
  return {
    sensitiveValues: [...sensitiveValues]
      .filter((value) => value.length >= 3)
      .sort((left, right) => right.length - left.length),
  };
}

export function redact(value: unknown, key = '', context: RedactionContext = { sensitiveValues: [] }): unknown {
  if (sensitiveKey.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    let result = value
      .replace(likelyBearer, 'Bearer [REDACTED]')
      .replace(email, '[REDACTED_EMAIL]')
      .replace(formattedSsn, '[REDACTED_SSN]');
    for (const sensitiveValue of context.sensitiveValues) result = result.split(sensitiveValue).join('[REDACTED]');
    return result.replace(/\b\d{5,}\b/g, '[REDACTED]');
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, key, context));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey, context)]),
    );
  return value;
}
