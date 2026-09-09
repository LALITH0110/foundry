import { randomUUID } from 'node:crypto';

export type Owner = 'automation' | 'human';
export type OwnershipToken = { sessionId: string; owner: Owner; epoch: number };

export class SessionController {
  readonly sessionId = randomUUID();
  private owner: Owner = 'automation';
  private epoch = 1;
  token(): OwnershipToken {
    return { sessionId: this.sessionId, owner: this.owner, epoch: this.epoch };
  }
  assert(token: OwnershipToken, owner: Owner): void {
    if (
      token.sessionId !== this.sessionId ||
      token.owner !== owner ||
      token.epoch !== this.epoch ||
      this.owner !== owner
    )
      throw new Error('STALE_OWNERSHIP_TOKEN');
  }
  transfer(to: Owner): OwnershipToken {
    this.owner = to;
    this.epoch += 1;
    return this.token();
  }
}
