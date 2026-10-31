# Domain docs

## Layout and reading rules

This repository uses a single-context layout:

- `GLOSSARY.md` at the repository root defines domain vocabulary.
- `docs/adr/` contains architectural decision records.

Before exploring the codebase, read the glossary and ADRs relevant
to the area being explored.

If these files do not exist, proceed silently. The domain-modeling
skill creates them when terms or decisions are resolved.

## Vocabulary

Use glossary terms in issue titles, proposals, hypotheses, and tests.
If a needed concept is missing, reconsider whether it belongs to the
domain; note genuine gaps for domain-modeling.

## Decision conflicts

Explicitly surface proposals that contradict an existing ADR,
including the ADR reference and reason for reconsidering it.
