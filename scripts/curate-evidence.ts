import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [discoveryRunId, replayRunId] = process.argv.slice(2);
if (!discoveryRunId || !replayRunId) {
  throw new Error('Usage: npm run curate:evidence -- <discovery-run-id> <replay-run-id>');
}

async function curate(runId: string, kind: 'discovery' | 'replay'): Promise<void> {
  const source = join('evidence/runtime', runId);
  const destination = join('evidence/reviewed', kind);
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  if (manifest.kind !== kind) throw new Error(`${runId} is not a ${kind} run`);
  if (kind === 'replay' && manifest.modelRequests !== 0)
    throw new Error('Replay evidence must report zero model requests');

  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const name of ['manifest.json', 'events.jsonl', 'success.json']) {
    await copyFile(join(source, name), join(destination, name));
  }
  await rewriteEvidencePaths(join(destination, 'events.jsonl'), runId, destination);
}

/**
 * Repoint recorded artifact paths at the curated copy. Matching on the run directory
 * rather than the literal run id matters: redaction masks an all-numeric id segment, so
 * the id inside an event payload does not always survive as written.
 */
async function rewriteEvidencePaths(eventsPath: string, _runId: string, destination: string): Promise<void> {
  const events = await readFile(eventsPath, 'utf8');
  await writeFile(eventsPath, events.replace(/evidence\/runtime\/[^"\\/\s]+\//g, `${destination}/`));
}

await curate(discoveryRunId, 'discovery');
await curate(replayRunId, 'replay');
for (const specification of process.argv.slice(4)) {
  const [name, runId] = specification.split('=');
  if (!name || !runId || !/^[a-z-]+$/.test(name)) throw new Error(`Invalid scenario specification: ${specification}`);
  const source = join('evidence/runtime', runId);
  const destination = join('evidence/reviewed', 'scenarios', name);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const file of await readdir(source)) {
    if (file.endsWith('.json') || file.endsWith('.jsonl') || file.endsWith('.png')) {
      await copyFile(join(source, file), join(destination, file));
    }
  }
  await rewriteEvidencePaths(join(destination, 'events.jsonl'), runId, destination);
}
console.log(`Curated discovery ${discoveryRunId} and replay ${replayRunId}.`);
