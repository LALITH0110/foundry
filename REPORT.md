# 1. Architecture

Foundry is a local vertical slice with three processes: LegacyBank, an intentionally awkward synthetic banking UI; Ollama, used only during discovery; and the Foundry runner, which owns one Playwright browser session. The runner separates observation and UI mechanics (`SurfaceAdapter`), model decisions, policy, action execution, artifact compilation, deterministic replay, evidence, and ownership transfer.

Discovery gives the model a bounded description of the rendered UI and asks for one schema-constrained action. Each request has a 30-second deadline. The shared executor validates an observation-local control, policy, ownership, and the session-wide action budget before it performs the real click, fill, or selection. Completion is only a proposal: code independently verifies the requested member and every review value. The compiler consumes execution receipts rather than a model-written transcript.

The division of labor is deliberate. The engineer authors what the capability _means_ — typed inputs and how each renders in a UI, typed outputs, known business outcomes, and the success predicate. The model chooses the _route_, and may drive any control the policy gate left in the observation, whether or not a contract step mentions it. Two constraints hold regardless: it can only name a control present in the current observation, and for a fill or select it must name a declared input rather than write a value, so invocation data never originates in the model. I considered requiring every executed action to match a pre-authored step, which is stricter and easier to review, and rejected it: a capability whose route was fully enumerated in advance is not discovery, and the honest guardrail is the policy gate plus an independent success check, not a pre-drawn map. A run that wanders produces no artifact, because compilation only happens once the engineer's predicate passes.

That leaves discovered steps whose semantics nothing declared. Where a step matches a pre-authored control it inherits that control's effect and checkpoints; otherwise it carries the checkpoints the run observed and a conservative `reversible` effect, and the provenance note reports the split. Promotion to `irreversible` is a review decision, not an inference — the schema then forces a precondition checkpoint and replay gates the step on approval.

Qwen3 4B keeps the demonstration local, free to run, reproducible, and suitable for regulated-data boundaries. The runner gives it only a pre-filtered list of policy-allowed controls. That constrained action space is both why a small model is adequate and part of the safety design: the prompt names no forbidden control, because forbidden controls are removed from the observation and are not resolvable by the executor. A guardrail the model is merely asked to respect is not a guardrail.

Replay is a separate entry point that does not import the Ollama adapter. It interprets saved capability JSON through the same surface, policy, and executor. A single process makes session ownership and handoff real without queues or distributed infrastructure that the assignment does not require.

# 2. Artifact schema

The runtime-validated JSON separates format version, capability version, vendor compatibility, typed inputs and outputs, entry point, targets, ordered steps, outcome handlers, success predicates, extraction bindings, external policy profile, and provenance.

Values are tagged references rather than string interpolation. Generic `minorUnits`, `template`, and `map` formats handle display values without capability-specific code. Currency remains integer minor units at the boundary. Predicates are a closed union; artifacts cannot contain executable expressions. Targets use stable user-facing relationships such as role and name or a frame, table row, and constrained control. Every target must resolve to exactly one visible control.

Each declared input carries an optional `display` format, which is what lets the two halves separate cleanly. Formatting an amount as `87.42` is engineer knowledge about the capability, not about any particular field, so attaching it to the input rather than to a step means the model can direct that input at a control it found itself and the runner still writes a correctly formatted value.

The artifact distinguishes trace-derived steps from engineer-authored runtime knowledge. An engineer defines the callable inputs and outputs, success predicate, and known outcomes; the model discovers the path through the UI. A successful run cannot teach what “session expired” means, so handlers and safety policy are versioned separately and identified in provenance.

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

Replay makes no learned decisions. For each step it validates ownership and policy, evaluates conditions in fixed order, resolves a unique target, acts once, and waits for an explicit predicate under a deadline. The surface enforces one monotonic action budget for the entire session, including recovery. It never chooses the first ambiguous match or asks a model to heal an unknown replay state. Final output comes from the live review screen and is checked against the invocation.

Results distinguish success, business outcomes, recoverable conditions, intervention, and failure. A missing member or account and a restricted account are caller-relevant results. A known interstitial gets one contract-defined recovery attempt; failed recovery escalates. Slow rendering uses bounded predicate polling, and an expired postcondition emits `TIMEOUT`. App errors, policy denials, ambiguity, and failed checkpoints stop with a step, expectation, observation, sanitized snapshot, and masked screenshot. Reversible draft edits are annotated and never blindly retried. The flow contains no irreversible financial action and stops before submit.

“Deterministic” means the same action policy for the same observed states, not identical timing or immutable external data. Evidence records the capability version, ownership epoch, semantic actions, predicates, and `modelRequests: 0` for replay.

# 4. Heterogeneity & multi-tenant

Replay depends on `SurfaceAdapter` for actions, predicates, reads, sanitized snapshots, masked failure capture, human-event listening, and session ownership. Playwright implements that contract; the interpreter has no browser-specific dependency. A desktop adapter could use OS accessibility targets. A visual adapter would need bounded regions, pinned OCR and template settings, confidence thresholds, and ambiguity rejection.

For institutions sharing a vendor, the reusable unit is vendor capability plus compatible product version plus restrictive tenant binding. The binding supplies only an origin, entry path, and frame title. Loading it verifies vendor and version; request and action policy remains authoritative. Acceptance tests run the same discovered artifact against Cedar and Harbor branded variants. Unknown versions or failed structural checkpoints stop instead of generating per-tenant automation.

# 5. Escalation & handoff

The runner owns a session ID and monotonically increasing ownership epoch. Every automated action requires the current automation token. On expiry or an unknown safe-to-escalate state, the runner stops dispatch, records context, increments the epoch, and yields the existing browser to a human. Old callbacks cannot act because their token is stale.

The intervention callback receives the reason, step, exact resume predicate, and an instruction derived from that predicate. A new automation epoch is issued only after the engine validates the checkpoint. Steps declare `read`, `reversible`, or `irreversible` effects. An irreversible step cannot execute until the callback explicitly returns `approved: true`; declining leaves an `APPROVAL_REQUIRED` intervention. Human events are recorded without typed field values. Production would put input arbitration in an authenticated remote-session gateway; the local demo assumes a trusted operator.

# 6. Safety

Trusted configuration allowlists parsed origins, path prefixes, and operations and separately denies the submit route. Request interception covers navigation and page resources, and service workers are disabled. Immediately before dispatch, policy checks the resolved element's accessible identity and its actual anchor or form destination. The model has no arbitrary JavaScript, shell, filesystem, or request tool.

Artifacts carry a policy reference but cannot grant permission. Inputs are validated before navigation and held in memory. Artifacts store references, not values. Evidence persists a semantic control inventory without page bodies, field values, or table-row contents, then redacts artifact-marked values and PII patterns. Failure screenshots mask fields and table values. Raw cookies, browser storage, prompts, traces, and unmasked screenshots are excluded. A byte scan covers committed evidence with seeded and unfamiliar canaries, and the same check verifies that the committed artifact's provenance names the reviewed discovery run and model, so a hand-edited capability cannot pass as discovered.

Reviewed fault and handoff runs are generated by the deterministic test harness with scripted operator callbacks. The headed demo exercises the separate manual operator path. The two approval runs are the one case where the artifact itself is modified: the reviewed workflow contains no irreversible step by design, so the test promotes the `Continue to review` step's effect to `irreversible` on an in-memory copy and replays that. The gating code and the evidence are real; the irreversible step is synthetic, and `capabilities/` is unchanged.

# 7. Cuts

I implemented one browser adapter, one deep workflow, restrictive bindings for two branded tenant variants, an agent-facing catalog, and a fault matrix. I did not build desktop or vision automation, hosted infrastructure, credential handling, tenant provisioning, a remote co-browsing console, or model-assisted replay recovery. The small acceptance matrix is not a statistical reliability claim; production confidence would require materially more repeated runs.

The clearest remaining gap is the review step between discovery and production use. A discovered step that matched no pre-authored control gets a conservative `reversible` effect, and today the only thing that changes it is someone editing the JSON. What that wants is the draft-to-approved workflow: a discovered artifact lands as a draft, a reviewer confirms each unannotated step's effect and checkpoints, replay of a draft is attended, and only an approved version is callable unattended. The schema already carries the version, effects, and provenance split that such a gate would read; what is missing is the state and the workflow around it. I would build that next, ahead of a second surface adapter.
