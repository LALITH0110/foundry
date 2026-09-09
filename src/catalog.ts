import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { capabilitySchema, type Capability } from './contracts/artifact.js';

function valueSchema(definition: Capability['inputSchema'][string] | Capability['outputSchema'][string]) {
  return {
    type: definition.type === 'integer' ? 'integer' : 'string',
    ...('pattern' in definition && definition.pattern ? { pattern: definition.pattern } : {}),
    ...('enum' in definition && definition.enum ? { enum: definition.enum } : {}),
    ...('minimum' in definition && definition.minimum !== undefined ? { minimum: definition.minimum } : {}),
    ...('maximum' in definition && definition.maximum !== undefined ? { maximum: definition.maximum } : {}),
  };
}

export function toAgentTool(capability: Capability) {
  return {
    type: 'function',
    function: {
      name: capability.id,
      description: capability.description,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: Object.fromEntries(
          Object.entries(capability.inputSchema).map(([name, definition]) => [name, valueSchema(definition)]),
        ),
        required: Object.entries(capability.inputSchema)
          .filter(([, definition]) => definition.required)
          .map(([name]) => name),
      },
      'x-output-schema': {
        type: 'object',
        additionalProperties: false,
        properties: Object.fromEntries(
          Object.entries(capability.outputSchema).map(([name, definition]) => [name, valueSchema(definition)]),
        ),
        required: Object.keys(capability.outputSchema),
      },
      'x-capability': {
        version: capability.version,
        lifecycle: capability.lifecycle,
        callable: capability.lifecycle === 'approved',
        policyProfile: capability.policyProfile,
      },
    },
  };
}

const directory = process.argv[2] ?? 'capabilities';
const files = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
const artifacts = await Promise.all(
  files.map(async (name) => capabilitySchema.parse(JSON.parse(await readFile(join(directory, name), 'utf8')))),
);
const capabilities = new Map<string, Capability>();
for (const artifact of artifacts) {
  const current = capabilities.get(artifact.id);
  if (!current || artifact.provenance.kind === 'discovered') capabilities.set(artifact.id, artifact);
}
console.log(JSON.stringify([...capabilities.values()].map(toAgentTool), null, 2));
