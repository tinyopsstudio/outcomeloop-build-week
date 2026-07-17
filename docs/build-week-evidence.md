# OpenAI Build Week Evidence

## Eligibility

- Track: Developer Tools
- Submission period: July 13-21, 2026
- Project creation: July 17, 2026
- Pre-existing project code: none
- License: MIT
- Runtime model: `gpt-5.6-terra`
- Codex surface: Codex CLI and Codex desktop development task

The [official rules](https://openai.devpost.com/rules) require a working project built with Codex and GPT-5.6, a repository, README, public video, and the `/feedback` session ID from the primary development task. The Devpost form carries that primary task ID; it is not embedded in source code.

## GPT-5.6 Is Material

OutcomeLoop is not a static wrapper with a decorative model call. GPT-5.6 is the execution engine that:

1. inspects the target workspace;
2. chooses and performs the next concrete action;
3. returns a strict structured progress report;
4. interprets external verifier failures; and
5. continues in the same stateful Codex session until deterministic proof exists.

Without GPT-5.6, the controller can validate state but cannot perform or adapt the work.

## Live Acceptance Run

Run started at `2026-07-17T11:36:34.121Z` and finished at `2026-07-17T11:37:56.915Z`.

| Field | Evidence |
| --- | --- |
| Codex session | `019f6fdd-3078-7e53-8bd6-94ca060b0dfc` |
| Iterations | 4 |
| Verifier exits | Preflight `2`; turns `7`, `1`, `8`, `0` |
| Final verifier output | `external acceptance handshake verified` |
| Protected roots | 2 |
| Ed25519 receipt signature | Valid |
| Active elapsed time | 82.792 seconds |
| Receipt hash | `112b0cbedf3a5dd3bd2f704dd1730159de65e56bd23bf7e4a1728ba317730085` |
| Signing key ID | `5baa472032069e001861a62597788ca0a7412909df741c0d28091d8df5da6832` |

The challenge nonce was generated only after turn 1. Turn 2 returned the wrong response field, so the external verifier rejected it. Turn 3 corrected that response and triggered a second random confirmation. Turn 4 completed the confirmation and passed, all in the same Codex session. This is the behavior the project exists to provide.

## Development Decisions Made With Codex

- Chose a deterministic verifier boundary instead of trusting model self-assessment.
- Rejected the first model alias after live evidence showed ChatGPT-backed Codex required `gpt-5.6-terra`.
- Corrected the strict output schema after the API required every property, including nullable `gate`, in `required`.
- Removed an unsupported resume flag after testing `codex exec resume` directly.
- Added fail-fast configuration diagnostics instead of spending all iterations on a bad invocation.
- Added protected verifier fingerprints after recognizing that a prompt-only "do not edit" rule was insufficient.
- Moved the live verifier outside the writable workspace.
- Added controller-managed state, Ed25519 receipt signatures, preflight verification, process-tree timeouts, and exclusive run locking after adversarial review.
- Isolated verifier-reached workspace code with a custom Codex OS permission profile, sanitized environment, controller-state denial, and disabled network.
- Isolated every initial and resumed Codex turn in a private per-run Codex home with a custom workspace-only permission profile, credential/controller-state denial, sanitized shell environment, and disabled network.
- Added authenticated child-exit reporting so a signal or forged verifier message cannot satisfy a nonzero success code.
- Added shutdown process-tree cleanup, configuration retry recovery, active-time preservation across owner gates, and lazy dashboard key loading after deeper review.
- Added centralized redaction for model reports, verifier output, JSON diagnostics, and bare API-token forms.
- Added an explicit gate allowlist and rejection test for invented approval gates.
- Built and visually checked the dashboard at 1440x1000 and 390x844.

## Verification Summary

- Node test suite: 65 passing tests, including four live OS-sandbox regressions
- Plugin validator: passed
- Isolated marketplace installation: passed
- Live single-turn GPT-5.6 repair: passed
- Live four-turn GPT-5.6 resume workflow: passed
- Ed25519 receipt signature plus current protected files: passed
- Desktop and mobile dashboard screenshots: passed visual review

Sanitized live data is committed at [`public/demo-data.json`](../public/demo-data.json). Generated workspace state, raw local sessions, and private environment details are excluded from Git.
