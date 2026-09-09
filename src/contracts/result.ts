export type BusinessCode = string;
export type FailureCode = string;

export type RunResult =
  | { status: 'success'; outputs: Record<string, string | number>; runId: string }
  | { status: 'business_outcome'; code: BusinessCode; runId: string }
  | { status: 'intervention_required'; code: string; interventionId: string; runId: string }
  | {
      status: 'failed';
      code: FailureCode;
      stepId?: string;
      expected: string;
      observed: string;
      evidence: string[];
      runId: string;
    };
