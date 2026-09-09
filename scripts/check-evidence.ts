import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

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
const migration = JSON.parse(await readFile(join(root, 'discovery', 'contract-migration.json'), 'utf8')) as {
  artifactSha256: string;
};
const artifact = await readFile('capabilities/prepare-stop-payment.discovered.json');
const artifactSha256 = createHash('sha256').update(artifact).digest('hex');
if (migration.artifactSha256 !== artifactSha256) {
  throw new Error('Discovery contract-migration hash does not match the committed artifact');
}
console.log(`Checked ${files} evidence files; no sensitive canaries found.`);
