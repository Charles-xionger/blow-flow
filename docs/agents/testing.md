# Test selection and final validation

Choose checks by the behavior affected, including callers of shared code. Use the
commands in `package.json` as the source of truth for available checks.

## During implementation

- Run the relevant test file or named case for each behavior change. Expand to
  related tests when a failure or a changed dependency justifies it.
- Run typechecking after changing shared types or interfaces and before final
  validation. Batch lightweight independent checks. Run full fast and browser
  suites sequentially when they compete for CPU or contain short real-time deadlines.
- Use browser tests for focus, keyboard, drag, layout and end-to-end persistence
  behavior. Keep data-model edge cases in the faster public-interface tests.

## Final validation

Finish implementation and review fixes before starting final validation. Keep
application source, tests, configuration and environment files unchanged while
checks run; use that time for read-only work.

| Change | Required final checks |
| --- | --- |
| Documentation or skill wording only | Validate changed references and skill metadata; no application test run |
| Application or test-tooling code | Typecheck, lint affected code, and the full fast suite (`pnpm test`) |
| Localized browser behavior | Above checks plus the affected browser cases/files |
| Shared canvas state, persistence/save protocol, migrations, common node UI, routing, browser fixtures/server/data isolation, or uncertain browser impact | Above checks plus the full browser suite (`pnpm test:browser`) |

Changes confined to test reporting or selection tooling need real-runner checks
for both passing and failing outcomes plus a representative browser run. Escalate
to the full browser suite if startup, fixtures or isolation behavior also changes.

A full fast run and a full browser run are distinct checks. A passing full fast
suite does not imply browser coverage. Full browser regression belongs at the
final boundary, not inside every red-green cycle.

After a failure, fix it and rerun failed cases plus cases affected by the fix.
Repeat the full browser suite when the fix has broad or uncertain impact. Report
these separately: “full suite passed” versus “full run had failures; fixes passed
focused reruns.” Include counts and elapsed time instead of conflating results.

## Source-change detection

The Playwright config includes `scripts/source-guard-reporter.cjs`. It hashes
tracked and untracked application/test inputs and root `.env*` files; it excludes
runtime databases, generated build output and documentation. A pre-existing dirty
working tree is allowed.

The reporter samples at startup, before tests, after each test and at completion.
Any observed change remains invalidating even if later reverted. It prints changed
paths (never file contents) and makes Playwright exit unsuccessfully. This is a
sampling guard, not a filesystem lock: changes reverted entirely between samples
can escape detection. Keep sources fixed throughout a run.

Preserve this reporter when adding report formats; `--reporter` overrides the
configured reporters. When a run is invalidated by source changes, rerun the
required checks on the completed source state; individual passes from the
invalidated run cannot serve as final validation.
