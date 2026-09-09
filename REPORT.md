# 1. Architecture

Foundry is a local vertical slice with three processes: LegacyBank, an intentionally awkward synthetic banking UI; Ollama, used only during discovery; and the runner, which owns one Playwright browser session and separates observation and UI mechanics (`SurfaceAdapter`), model decisions, policy, execution, compilation, replay, evidence, and ownership transfer.

Discovery gives the model a bounded description of the rendered UI and asks for one schema-constrained action under a 30-second deadline. The same executor replay uses re-validates control, policy, ownership, and budget before the real click, fill, or selection. Completion is only a proposal: code independently verifies every review value, and the compiler consumes execution receipts, not a model-written transcript.

The division of labor is deliberate. The engineer authors what the capability _means_ — typed inputs and how each renders in a UI, typed outputs, known business outcomes, and the success predicate. The model chooses the _route_, and may drive any control the policy gate left in the observation. Two constraints hold regardless: it can only name a control present in the current observation, and for a fill or select it must name a declared input rather than write a value, so invocation data never originates in the model. I considered requiring every executed action to match a pre-authored step and rejected it: a route enumerated in advance is not discovery, and the honest guardrail is the policy gate plus an independent success check. A run that wanders produces no artifact.

Two contracts make that testable rather than asserted. The stop-payment contract pre-authors its full route, and its artifact reports all seven steps matched a known control — on its own, indistinguishable from replaying a map. The member-lookup contract pre-authors none: one entry navigation, then inputs, outputs, outcomes, and a success predicate. Its artifact reports `0 of 2 discovered steps matched a pre-authored control`, so both targets and both checkpoints came from the model against the live UI.

That leaves discovered steps whose semantics nothing declared. Where a step matches a pre-authored control it inherits that control's effect and checkpoints; otherwise it carries the checkpoints the run observed and a conservative `reversible` effect, and the provenance note reports the split. Promotion to `irreversible` is a review decision: the schema then forces a precondition checkpoint and replay gates the step on approval.

The runner gives the model only a pre-filtered list of policy-allowed controls. That constrained action space is both why a small local model is adequate and part of the safety design: the prompt names no forbidden control, because forbidden controls are removed from the observation and are not resolvable by the executor. A guardrail the model is merely asked to respect is not one.

Replay is a separate entry point that does not import the Ollama adapter; it interprets saved capability JSON through the same surface, policy, and executor. A single process makes session ownership and handoff real without infrastructure the assignment does not require.

# 2. Artifact schema

The runtime-validated JSON separates format and capability version, vendor compatibility, typed inputs and outputs, entry point, targets, ordered steps, outcome handlers, success predicates, extraction bindings, policy profile, lifecycle, and provenance.

Values are tagged references rather than string interpolation. Generic `minorUnits`, `template`, and `map` formats handle display values without capability-specific code, and currency stays integer minor units at the boundary. Predicates are a closed union; artifacts cannot contain executable expressions. Targets use stable user-facing relationships such as role and name, or a frame, table row, and constrained control, and must resolve to exactly one visible control.

Each declared input carries an optional `display` format, which lets the two halves separate cleanly. Formatting an amount as `87.42` is engineer knowledge, so attaching it to the input rather than to a step means the model can direct that input at a control it found itself and the runner still writes a correctly formatted value.

The artifact keeps trace-derived steps separate from engineer-authored runtime knowledge. A successful run cannot teach what “session expired” means, so handlers and safety policy are versioned independently of the discovered route and identified in provenance.

```json
{
  "step": {
    "action": {
      "kind": "fill",
      "value": { "kind": "input", "name": "amountMinor", "format": { "kind": "minorUnits", "scale": 2 } }
    },
    "effect": "reversible"
  },
  "handler": {
    "result": {
      "status": "recoverable",
      "action": { "kind": "click", "target": "dismiss-interstitial" },
      "maxAttempts": 1
    }
  },
  "success": { "predicate": { "kind": "all", "checks": [{ "kind": "urlPath", "path": "/workspace/review" }] } }
}
```

# 3. Determinism & error handling

Replay makes no learned decisions. For each step it validates ownership and policy, evaluates conditions in fixed order, resolves a unique target, acts once, and waits for an explicit predicate under a deadline. One monotonic action budget covers the whole session, including recovery. It never chooses the first ambiguous match or asks a model to heal an unknown state. Final output comes from the live screen and is checked against the invocation.

Results distinguish success, business outcomes, recoverable conditions, intervention, and failure. A missing member or account and a restricted account are caller-relevant results. A known interstitial gets one contract-defined recovery attempt; failed recovery escalates. Slow rendering uses bounded predicate polling, and an expired postcondition emits `TIMEOUT`. App errors, policy denials, ambiguity, and failed checkpoints stop with a step, expectation, observation, sanitized snapshot, and masked screenshot. The flow contains no irreversible financial action and stops before submit.

“Deterministic” means the same action policy for the same observed states, not identical timing or immutable external data. Evidence records the capability version and lifecycle, ownership epoch, semantic actions, predicates, and `modelRequests: 0`.

# 4. Heterogeneity & multi-tenant

Replay depends on `SurfaceAdapter` for actions, predicates, reads, sanitized snapshots, masked failure capture, human-event listening, and session ownership. Playwright implements that contract; the interpreter has no browser-specific dependency. A desktop adapter could use OS accessibility targets; a visual adapter would need bounded regions, pinned OCR settings, confidence thresholds, and ambiguity rejection.

For institutions sharing a vendor, the reusable unit is vendor capability plus compatible product version plus restrictive tenant binding. The binding supplies only an origin, entry path, and frame title; loading it verifies vendor and version, and request and action policy remains authoritative. Acceptance tests run the same discovered artifact against Cedar and Harbor branded variants. Unknown versions or failed structural checkpoints stop instead of generating per-tenant automation.

# 5. Escalation & handoff

The runner owns a session ID and a monotonically increasing ownership epoch, and every automated action requires the current automation token. On expiry or an unknown safe-to-escalate state, the runner stops dispatch, records context, increments the epoch, and yields the existing browser to a human. Old callbacks cannot act: their token is stale.

The intervention callback receives the reason, step, exact resume predicate, and an instruction derived from it. A new automation epoch is issued only after the engine validates the checkpoint. An irreversible step cannot execute until the callback returns `approved: true`; declining leaves an `APPROVAL_REQUIRED` intervention. Human events are recorded without typed field values. Production would put input arbitration in an authenticated remote-session gateway; the local demo assumes a trusted operator.

# 6. Safety

Trusted configuration allowlists parsed origins, path prefixes, and operations, and denies the submit route. Request interception covers navigation and page resources; service workers are disabled. Immediately before dispatch, policy checks the resolved element's accessible identity and its actual anchor or form destination. The model has no JavaScript, shell, filesystem, or request tool.

Artifacts carry a policy reference but cannot grant permission, and store references rather than values. Inputs are validated before navigation and held in memory. Evidence persists a semantic control inventory without page bodies, field values, or table-row contents, then redacts artifact-marked values and PII patterns; failure screenshots mask fields and table values. Raw cookies, storage, prompts, traces, and unmasked screenshots are excluded. A byte scan covers committed evidence with seeded and unfamiliar canaries, and the same check verifies each artifact's provenance names its reviewed discovery run and model, so a hand-edited capability cannot pass as discovered.

A `lifecycle` of `draft` or `approved` travels in the artifact, so a capability carries its own review state. Discovery can only write `draft`; promotion is a human edit. Unattended replay refuses anything else before acting, because a step matching no pre-authored control carries an _inferred_ `reversible` effect, and an inference is not a safety property. Attended review opts in with `allowDraft`.

Reviewed fault and handoff runs come from the deterministic test harness with scripted operator callbacks; the headed demo exercises the manual operator path. The two approval runs are the one case where the artifact is modified: the reviewed workflow contains no irreversible step by design, so the test promotes one step's effect on an in-memory copy and replays that. The gating code and the evidence are real; the irreversible step is synthetic, and `capabilities/` is unchanged.

# 7. Cuts

I built one browser adapter, two discovered capabilities, restrictive bindings for two tenant variants, an agent-facing catalog, an approval gate, and a fault matrix. I did not build desktop or vision automation, hosted infrastructure, credential handling, tenant provisioning, a co-browsing console, or model-assisted replay recovery. The small acceptance matrix is not a statistical reliability claim.

The review step is enforced but is not yet a workflow: promotion is one human editing one field, which does not scale.

Building the second capability exposed a sharper limit: outcome classification that depends on a route step cannot be discovered. Stop-payment reports `ACCOUNT_NOT_FOUND` because an engineer attached `onTargetMissing` to the step that opens an account; the lookup capability pre-authors no step and has nowhere to hang that, so a missing account surfaces as an unexpected-state intervention rather than a typed outcome. Both are safe, but only one is useful to a caller. The fix belongs in promotion — annotating a discovered step is exactly the moment to attach the outcome it can produce — and that is what I would build next, ahead of a second surface adapter.
