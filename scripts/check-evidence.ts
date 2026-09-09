import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const root = 'evidence/reviewed';
const forbidden = [
  'Morgan Test',
  'Riley Example',
  'Avery Stone',
  'avery.stone@example.test',
  '123-45-6789',
  '10001',
  '20002',
  '2468',
  '1357',
  '8642',
  '7777',
  '9021',
  '3388',
  '$87.42',
  '$42.00',
  'hunter2',
  'Bearer canary',
];
let files = 0;

async function walk(path: string): Promise<void> {
  for (const name of await readdir(path).catch(() => [])) {
    const full = join(path, name);
    if ((await stat(full)).isDirectory()) await walk(full);
    else {
      files += 1;
      const content = await readFile(full);
      if (name.endsWith('.png')) continue;
      const text = content.toString('utf8');
      for (const value of forbidden)
        if (text.includes(value)) throw new Error(`Sensitive canary found in ${full}: ${value}`);
      if (/"(?:text|context)"\s*:/.test(text)) throw new Error(`Unrestricted UI content field found in ${full}`);
      for (const line of text.split('\n')) {
        if (/"allowedActions"\s*:/.test(line) && /"value"\s*:/.test(line)) {
          throw new Error(`UI control value found in ${full}`);
        }
      }
      if (text.includes('evidence/runtime/')) throw new Error(`Curated evidence contains a runtime-only path: ${full}`);
    }
  }
}

await walk(root);

// Every committed discovered artifact must be the one its reviewed discovery run produced.
const discoveredArtifacts = [
  { artifact: 'capabilities/prepare-stop-payment.discovered.json', evidence: join(root, 'discovery') },
  { artifact: 'capabilities/lookup-member-account.discovered.json', evidence: join(root, 'lookup', 'discovery') },
];

for (const { artifact: artifactPath, evidence } of discoveredArtifacts) {
  const manifest = JSON.parse(await readFile(join(evidence, 'manifest.json'), 'utf8')) as {
    runId: string;
    model: string;
  };
  const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as {
    lifecycle?: string;
    provenance: { kind: string; discoveryRunId?: string; model?: string };
  };
  if (artifact.provenance.kind !== 'discovered') {
    throw new Error(`${artifactPath} is not labeled as discovered`);
  }
  if (artifact.provenance.discoveryRunId !== manifest.runId) {
    throw new Error(
      `${artifactPath} provenance run ${artifact.provenance.discoveryRunId} does not match reviewed discovery run ${manifest.runId}`,
    );
  }
  if (artifact.provenance.model !== manifest.model) {
    throw new Error(`${artifactPath} provenance model does not match its reviewed discovery run`);
  }
  console.log(
    `${artifactPath} traces to discovery run ${manifest.runId} (${manifest.model}), lifecycle ${artifact.lifecycle ?? 'draft'}.`,
  );
}
console.log(`Checked ${files} evidence files; no sensitive canaries found.`);
