# Demo Video Script

Target duration: 2 minutes 35 seconds. Public YouTube video with English voiceover.

## 0:00-0:18 - The Failure Mode

On screen: OutcomeLoop dashboard header, then the objective.

Voiceover:

"A coding agent can end a turn without finishing the real job. Context can compact, a tool can fail, or the agent can simply claim it is done. OutcomeLoop changes the stop condition: Codex keeps going until evidence outside the model says the outcome is true."

## 0:18-0:42 - The Contract

On screen: `outcomeloop.json`, highlighting objective, model, protected paths, and completion command.

Voiceover:

"This contract gives GPT-5.6 Terra a bounded workspace, explicit constraints, an owner-gate allowlist, and an external verifier. Every Codex turn runs with workspace-only access and no network. The verifier is fingerprinted outside that workspace and runs in a second sandbox that cannot read the signing key."

## 0:42-1:18 - Turn One Fails Externally

On screen: terminal starting the live demo, then proposal.json and dashboard timeline.

Voiceover:

"GPT-5.6 creates the initial proposal in Codex session 019f6fdd. Only after that turn ends does the external service generate a random challenge. The check exits seven. OutcomeLoop records the evidence and resumes the exact same session. A final message is not treated as completion."

## 1:18-1:48 - Resume Until Proof

On screen: challenge.json, the rejected response event, confirmation.json, then the fourth turn and final.json.

Voiceover:

"The second response uses the wrong field, so the verifier exits one. OutcomeLoop resumes again. GPT-5.6 corrects it, and the external service issues a second random confirmation with exit eight. The same session resumes once more, completes the confirmation, and only then does the check exit zero."

## 1:48-2:15 - Receipt And Integrity

On screen: `verify-receipt` output and dashboard verification panel.

Voiceover:

"The successful run signs the contract hash, model, Codex session, verifier output hash, repository state, and protected-file fingerprint with a controller-owned Ed25519 key. Rechecking validates the signature and the current verifier files."

## 2:15-2:35 - Codex And GPT-5.6 Contribution

On screen: architecture diagram and test output.

Voiceover:

"Codex built the plugin, runner, tests, dashboard, and live demo during OpenAI Build Week. GPT-5.6 is also the product's semantic execution engine: it inspects, acts, interprets external failures, and adapts. Deterministic code supplies the evidence boundary that makes those actions trustworthy."
