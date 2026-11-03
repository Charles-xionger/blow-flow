---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

If the user passes a ticket reference, fetch it from the issue tracker and state its title before starting. If the reference is ambiguous, ask.

Call the Skill tool with "tdd" where possible, at pre-agreed seams.

Read [the testing policy](../../../docs/agents/testing.md) before selecting checks. During implementation, use relevant test files and typecheck after shared type or interface changes.

Once implementation is ready, call the Skill tool with "code-review" and resolve its findings. Then run the final checks required by the testing policy against unchanged source. Distinguish full fast tests from full browser regression; changes after validation require rerunning affected checks.

Commit your work to the current branch.
