# Issue tracker: Local Markdown

Issues and specs live as Markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`.
- Spec: `.scratch/<feature-slug>/spec.md`.
- Tickets: `.scratch/<feature-slug>/issues/<NN>-<slug>.md`,
  numbered from 01, one file per ticket.
- Record triage state in a `Status:` line near the top,
  using the role strings in `triage-labels.md`.
- Append comments under a `## Comments` heading.

## Skill operations

- "Publish to the issue tracker": create the appropriate spec
  or ticket file using the paths above.
- "Fetch the relevant ticket": read the referenced file.
  Resolve ticket numbers within their feature directory.

## Wayfinding operations

- Map: `.scratch/<effort>/map.md`, containing Notes,
  Decisions-so-far, and Fog.
- Child ticket: `.scratch/<effort>/issues/NN-<slug>.md`,
  with the question in its body.
- Type: record `research`, `prototype`, `grilling`, or `task`
  in a `Type:` line.
- Wayfinding lifecycle: use `Status: open`, `Status: claimed`,
  or `Status: resolved` for these tickets.
  These lifecycle states are separate from ordinary triage roles.
- Blocking: record `Blocked by: NN, NN` near the top.
  A ticket is unblocked when all listed tickets are resolved.
- Frontier: select the first ticket by number that is open
  and unblocked.
- Claim: set `Status: claimed` and save before starting work.
- Resolve: append the answer under `## Answer`, set
  `Status: resolved`, then append a gist and link to the map's
  Decisions-so-far.
