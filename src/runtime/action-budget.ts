import { PolicyError } from '../safety/policy.js';

export class ActionBudgetExceededError extends PolicyError {
  constructor(
    readonly maximum: number,
    readonly attempted: number,
  ) {
    super(`Action budget exceeded: attempted ${attempted}, maximum ${maximum}`);
  }
}

export class ActionBudget {
  private consumed = 0;

  constructor(readonly maximum: number) {}

  consume(): number {
    const attempted = this.consumed + 1;
    if (attempted > this.maximum) throw new ActionBudgetExceededError(this.maximum, attempted);
    this.consumed = attempted;
    return this.consumed;
  }

  get used(): number {
    return this.consumed;
  }
}
