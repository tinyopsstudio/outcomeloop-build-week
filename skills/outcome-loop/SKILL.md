---
name: outcome-loop
description: Keep a Codex goal active until an external verifier proves the outcome. Use for long-running work, tasks that must survive context compaction or premature handoffs, explicit completion contracts, owner-gated operations, or requests to continue until a measurable result is achieved.
---

# OutcomeLoop

Use GPT-5.6 for semantic planning and Codex tool execution. Treat the configured verifier as the only authority on completion.

## Workflow

1. Turn the requested outcome into one concise objective.
2. Choose a deterministic verifier that observes the real result. Prefer an existing test, health check, query, or audit command. Do not create a verifier that merely checks an agent-authored status file.
3. Put verifier scripts and fixed test fixtures outside the writable workspace and temporary directory. Writable result artifacts may remain in the workspace. List every fixed verifier dependency in `protectedPaths`; task-writable protected paths and symlinks are rejected.
4. Keep irreversible or human-only actions in `allowedGates`. Do not broaden that list without the user's instruction.
5. From the plugin root, initialize the contract:

   `node src/cli.js init --objective "<objective>" -- <verifier> <args...>`

6. Review `outcomeloop.json`, especially the objective, verifier, protected paths, sandbox, constraints, runtime, and gate list.
7. Run `node src/cli.js run`. OutcomeLoop preflights the verifier, then resumes the same Codex session until it passes, an allowed owner gate is unavoidable, or the explicit iteration/runtime budget is exhausted.
8. Use `node src/cli.js verify-receipt` to validate the Ed25519 signature, contract hash, and protected files. Use `node src/cli.js serve` for the local timeline.

## Integrity Rules

- Never weaken, replace, skip, mock, or edit the verifier to make a run pass.
- Stop on `integrity_violation`; never bless a run after a protected file changes.
- Never put a fixed verifier dependency in the writable workspace or temporary directory; workspace result artifacts are expected to remain writable.
- Never treat a final message, summary, commit, deployment, or agent claim as completion unless the verifier passes.
- Keep verifier commands as argument arrays; do not add shell interpolation.
- Preserve unrelated working-tree changes.
- Store only redacted, bounded command output. Never put credentials in the contract, event log, receipt, or chat.
- An `owner_gate` is valid only when its type exactly appears in `allowedGates` and the owner action is the next unavoidable step.
- After a gate is cleared, use `run --resume-gate`; do not start a replacement session.
- Do not run the same contract concurrently; the controller lock intentionally rejects a second invocation.
