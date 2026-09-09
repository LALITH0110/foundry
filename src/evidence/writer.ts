import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { redact, type RedactionContext } from '../safety/redaction.js';

export class EvidenceWriter {
  readonly directory: string;
  constructor(readonly runId: string, base = 'evidence/runtime', private readonly redactionContext: RedactionContext = { sensitiveValues: [] }) { this.directory = join(base, runId); }
  async initialize(kind: 'discovery' | 'replay', details: Record<string, unknown>): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(join(this.directory, 'manifest.json'), JSON.stringify(redact({ runId: this.runId, kind, startedAt: new Date().toISOString(), ...details }, '', this.redactionContext), null, 2));
  }
  async event(type: string, data: Record<string, unknown> = {}): Promise<void> {
    const event = redact({ timestamp: new Date().toISOString(), runId: this.runId, type, ...data }, '', this.redactionContext);
    await appendFile(join(this.directory, 'events.jsonl'), `${JSON.stringify(event)}\n`);
  }
  async snapshot(name: string, snapshot: unknown): Promise<string> {
    const path = join(this.directory, `${name}.json`);
    await writeFile(path, JSON.stringify(redact(snapshot, '', this.redactionContext), null, 2));
    return path;
  }
  artifactPath(name: string): string {
    return join(this.directory, name);
  }
}
