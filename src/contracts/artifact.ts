import { z } from 'zod';

const resultCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'Result codes must use UPPER_SNAKE_CASE');

const valueFormatSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('minorUnits'), scale: z.number().int().min(0).max(6), prefix: z.string().optional() })
    .strict(),
  z
    .object({
      kind: z.literal('template'),
      template: z.string().refine((value) => value.includes('{{value}}'), 'Template must contain {{value}}'),
    })
    .strict(),
  z.object({ kind: z.literal('map'), values: z.record(z.string(), z.string()) }).strict(),
]);

export const valueRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('input'), name: z.string().min(1), format: valueFormatSchema.optional() }).strict(),
  z.object({ kind: z.literal('constant'), value: z.union([z.string(), z.number(), z.boolean()]) }).strict(),
]);
export type ValueRef = z.infer<typeof valueRefSchema>;

export const targetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('role'),
      frame: z.string(),
      role: z.string(),
      name: z.string(),
      exact: z.boolean().default(true),
    })
    .strict(),
  z
    .object({ kind: z.literal('label'), frame: z.string(), label: z.string(), exact: z.boolean().default(true) })
    .strict(),
  z.object({ kind: z.literal('text'), frame: z.string(), text: z.string(), exact: z.boolean().default(true) }).strict(),
  z
    .object({
      kind: z.literal('tableRowLink'),
      frame: z.string(),
      rowTexts: z.array(valueRefSchema).min(1),
      linkName: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('tableRowControl'),
      frame: z.string(),
      rowText: z.string(),
      control: z.enum(['input', 'select']),
    })
    .strict(),
  z.object({ kind: z.literal('tableRowValue'), frame: z.string(), rowText: z.string() }).strict(),
]);
export type TargetSpec = z.infer<typeof targetSchema>;

export const predicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('visible'), target: z.string() }).strict(),
    z.object({ kind: z.literal('urlPath'), path: z.string().startsWith('/') }).strict(),
    z.object({ kind: z.literal('textEquals'), target: z.string(), value: valueRefSchema }).strict(),
    z.object({ kind: z.literal('all'), checks: z.array(predicateSchema).min(1) }).strict(),
  ]),
);
export type Predicate =
  | { kind: 'visible'; target: string }
  | { kind: 'urlPath'; path: string }
  | { kind: 'textEquals'; target: string; value: ValueRef }
  | { kind: 'all'; checks: Predicate[] };

export const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate'), path: z.string().startsWith('/') }).strict(),
  z.object({ kind: z.literal('click'), target: z.string() }).strict(),
  z.object({ kind: z.literal('fill'), target: z.string(), value: valueRefSchema }).strict(),
  z.object({ kind: z.literal('select'), target: z.string(), value: valueRefSchema }).strict(),
]);
export type ActionSpec = z.infer<typeof actionSchema>;

const businessOutcomeSchema = z.object({ status: z.literal('business_outcome'), code: resultCodeSchema }).strict();
const handlerSchema = z
  .object({
    id: z.string(),
    when: predicateSchema,
    result: z.discriminatedUnion('status', [
      businessOutcomeSchema,
      z.object({ status: z.literal('intervention_required'), code: resultCodeSchema }).strict(),
      z.object({ status: z.literal('failed'), code: resultCodeSchema }).strict(),
      z
        .object({
          status: z.literal('recoverable'),
          action: actionSchema,
          postcondition: predicateSchema,
          maxAttempts: z.literal(1),
        })
        .strict(),
    ]),
  })
  .strict();

const capabilityStructureSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    id: z.string(),
    version: z.string(),
    description: z.string(),
    vendor: z.string(),
    compatibleVersions: z.array(z.string()),
    // Discovery always writes `draft`. Promotion to `approved` is a reviewer decision
    // recorded by editing this one field; unattended replay refuses anything else.
    lifecycle: z.enum(['draft', 'approved']).default('draft'),
    entry: z.object({ path: z.string().startsWith('/') }).strict(),
    inputSchema: z.record(
      z.string(),
      z
        .object({
          type: z.enum(['string', 'integer']),
          required: z.boolean(),
          sensitive: z.boolean().optional(),
          pattern: z.string().optional(),
          enum: z.array(z.string()).optional(),
          minimum: z.number().int().optional(),
          maximum: z.number().int().optional(),
          display: valueFormatSchema.optional(),
        })
        .strict(),
    ),
    outputSchema: z.record(
      z.string(),
      z.object({ type: z.enum(['string', 'integer']), sensitive: z.boolean().optional() }).strict(),
    ),
    targets: z.record(z.string(), targetSchema),
    steps: z
      .array(
        z
          .object({
            id: z.string(),
            action: actionSchema,
            effect: z.enum(['read', 'reversible', 'irreversible']),
            precondition: predicateSchema.optional(),
            postcondition: predicateSchema.optional(),
            onTargetMissing: businessOutcomeSchema.optional(),
            timeoutMs: z.number().int().positive().max(30_000),
          })
          .strict(),
      )
      .min(1),
    handlers: z.array(handlerSchema),
    success: z
      .object({
        predicate: predicateSchema,
        outputs: z.record(
          z.string(),
          z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('constant'), value: z.union([z.string(), z.number()]) }).strict(),
            z.object({ kind: z.literal('input'), name: z.string() }).strict(),
            z.object({ kind: z.literal('extract'), target: z.string(), parse: z.enum(['text', 'usdMinor']) }).strict(),
          ]),
        ),
      })
      .strict(),
    policyProfile: z.string().min(1),
    provenance: z
      .object({
        kind: z.enum(['discovered', 'example']),
        discoveryRunId: z.string().optional(),
        model: z.string().optional(),
        note: z.string().optional(),
      })
      .strict(),
  })
  .strict();

export const capabilitySchema = capabilityStructureSchema.superRefine((capability, context) => {
  const targetNames = new Set(Object.keys(capability.targets));
  const inputNames = new Set(Object.keys(capability.inputSchema));
  const issue = (message: string, path: Array<string | number>) => context.addIssue({ code: 'custom', message, path });
  const checkValue = (value: ValueRef, path: Array<string | number>) => {
    if (value.kind !== 'input') return;
    const definition = capability.inputSchema[value.name];
    if (!definition) return issue(`Unknown input reference: ${value.name}`, path);
    if (value.format?.kind === 'minorUnits' && definition.type !== 'integer') {
      issue('minorUnits format requires an integer input', [...path, 'format']);
    }
    if (value.format?.kind === 'map' && definition.type !== 'string') {
      issue('map format requires a string input', [...path, 'format']);
    }
  };
  const checkPredicate = (predicate: Predicate, path: Array<string | number>): void => {
    if (predicate.kind === 'all') {
      predicate.checks.forEach((check, index) => checkPredicate(check, [...path, 'checks', index]));
      return;
    }
    if (predicate.kind !== 'urlPath' && !targetNames.has(predicate.target)) {
      issue(`Unknown target reference: ${predicate.target}`, [...path, 'target']);
    }
    if (predicate.kind === 'textEquals') checkValue(predicate.value, [...path, 'value']);
  };
  const checkAction = (action: ActionSpec, path: Array<string | number>) => {
    if (action.kind !== 'navigate' && !targetNames.has(action.target)) {
      issue(`Unknown target reference: ${action.target}`, [...path, 'target']);
    }
    if (action.kind === 'fill' || action.kind === 'select') checkValue(action.value, [...path, 'value']);
  };

  const stepIds = new Set<string>();
  for (const [name, target] of Object.entries(capability.targets)) {
    if (target.kind === 'tableRowLink') {
      target.rowTexts.forEach((value, index) => checkValue(value, ['targets', name, 'rowTexts', index]));
    }
  }
  capability.steps.forEach((step, index) => {
    const path = ['steps', index] as Array<string | number>;
    if (stepIds.has(step.id)) issue(`Duplicate step id: ${step.id}`, [...path, 'id']);
    stepIds.add(step.id);
    checkAction(step.action, [...path, 'action']);
    if (step.precondition) checkPredicate(step.precondition, [...path, 'precondition']);
    if (step.postcondition) checkPredicate(step.postcondition, [...path, 'postcondition']);
    if (step.onTargetMissing && !step.precondition) {
      issue('onTargetMissing requires a screen-confirming precondition', [...path, 'onTargetMissing']);
    }
    if (step.effect === 'irreversible' && !step.precondition) {
      issue('irreversible steps require a precondition checkpoint', [...path, 'effect']);
    }
  });
  capability.handlers.forEach((handler, index) => {
    checkPredicate(handler.when, ['handlers', index, 'when']);
    if (handler.result.status === 'recoverable') {
      checkAction(handler.result.action, ['handlers', index, 'result', 'action']);
      checkPredicate(handler.result.postcondition, ['handlers', index, 'result', 'postcondition']);
    }
  });
  checkPredicate(capability.success.predicate, ['success', 'predicate']);

  for (const [name, source] of Object.entries(capability.success.outputs)) {
    if (source.kind === 'input' && !inputNames.has(source.name)) {
      issue(`Unknown input reference: ${source.name}`, ['success', 'outputs', name]);
    }
    if (source.kind === 'extract' && !targetNames.has(source.target)) {
      issue(`Unknown target reference: ${source.target}`, ['success', 'outputs', name]);
    }
    const declared = capability.outputSchema[name];
    if (!declared) {
      issue(`Output binding is not declared: ${name}`, ['success', 'outputs', name]);
      continue;
    }
    const sourceType =
      source.kind === 'constant'
        ? typeof source.value === 'number'
          ? 'integer'
          : 'string'
        : source.kind === 'input'
          ? capability.inputSchema[source.name]?.type
          : source.parse === 'usdMinor'
            ? 'integer'
            : 'string';
    if (sourceType && sourceType !== declared.type) {
      issue(`Output ${name} declares ${declared.type} but its binding produces ${sourceType}`, [
        'success',
        'outputs',
        name,
      ]);
    }
  }
  for (const name of Object.keys(capability.outputSchema)) {
    if (!(name in capability.success.outputs)) issue(`Declared output has no binding: ${name}`, ['outputSchema', name]);
  }
  for (const [name, definition] of Object.entries(capability.inputSchema)) {
    if (definition.pattern) {
      try {
        new RegExp(definition.pattern);
      } catch {
        issue(`Invalid input pattern: ${name}`, ['inputSchema', name, 'pattern']);
      }
    }
    if (definition.enum && definition.type !== 'string')
      issue('enum is supported only for string inputs', ['inputSchema', name, 'enum']);
    if ((definition.minimum !== undefined || definition.maximum !== undefined) && definition.type !== 'integer') {
      issue('numeric bounds require an integer input', ['inputSchema', name]);
    }
    if (
      definition.minimum !== undefined &&
      definition.maximum !== undefined &&
      definition.minimum > definition.maximum
    ) {
      issue('minimum cannot exceed maximum', ['inputSchema', name]);
    }
    if (definition.display?.kind === 'minorUnits' && definition.type !== 'integer') {
      issue('minorUnits display requires an integer input', ['inputSchema', name, 'display']);
    }
    if (definition.display?.kind === 'map' && definition.type !== 'string') {
      issue('map display requires a string input', ['inputSchema', name, 'display']);
    }
  }
});

export type Invocation = Record<string, string | number>;
export type Capability = z.infer<typeof capabilitySchema>;

function contractValueSchema(
  definition: Capability['inputSchema'][string] | Capability['outputSchema'][string],
): z.ZodType {
  if (definition.type === 'string') {
    let schema = z.string();
    if ('pattern' in definition && definition.pattern) schema = schema.regex(new RegExp(definition.pattern));
    if ('enum' in definition && definition.enum) {
      schema = schema.refine(
        (value) => definition.enum!.includes(value),
        `Expected one of: ${definition.enum.join(', ')}`,
      );
    }
    return schema;
  }
  let schema = z.number().int();
  if ('minimum' in definition && definition.minimum !== undefined) schema = schema.min(definition.minimum);
  if ('maximum' in definition && definition.maximum !== undefined) schema = schema.max(definition.maximum);
  return schema;
}

export function parseInvocation(capability: Capability, value: unknown): Invocation {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, definition] of Object.entries(capability.inputSchema)) {
    const schema = contractValueSchema(definition);
    shape[name] = definition.required ? schema : schema.optional();
  }
  return z.object(shape).strict().parse(value) as Invocation;
}

export function parseOutputs(capability: Capability, value: unknown): Record<string, string | number> {
  const shape = Object.fromEntries(
    Object.entries(capability.outputSchema).map(([name, definition]) => [name, contractValueSchema(definition)]),
  );
  return z.object(shape).strict().parse(value) as Record<string, string | number>;
}

export function resolveValue(ref: ValueRef, inputs: Invocation): string {
  const value = ref.kind === 'constant' ? ref.value : inputs[ref.name];
  if (ref.kind === 'constant' || !ref.format) return String(value);
  if (ref.format.kind === 'minorUnits') {
    return `${ref.format.prefix ?? ''}${(Number(value) / 10 ** ref.format.scale).toFixed(ref.format.scale)}`;
  }
  if (ref.format.kind === 'template') return ref.format.template.replaceAll('{{value}}', String(value));
  const mapped = ref.format.values[String(value)];
  if (mapped === undefined) throw new Error(`No mapped display value for input ${ref.name}`);
  return mapped;
}

/**
 * The value reference an engineer declared for an input, independent of any step.
 * Discovery uses this so the model can direct a typed input at a control it found
 * itself, without a pre-authored step supplying the display format.
 */
export function inputValueRef(capability: Capability, name: string): ValueRef {
  const display = capability.inputSchema[name]?.display;
  return { kind: 'input', name, ...(display ? { format: display } : {}) };
}

export function targetSignature(target: TargetSpec): string {
  return JSON.stringify(target);
}
