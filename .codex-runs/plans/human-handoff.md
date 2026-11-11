# MyDot durable human handoff (#22 / Campaign #1949)

## Goal, audience and current behavior
The owner answers a versioned request in MyDot or saves the associated survey result; the original server Session resumes once and retains a visible result or stopping reason across browser closure and Host restart. Existing MyDot jobs/files reuse Session and inbox records, but lack a durable business request, independent receipt/admission/outcome states and server callback.

## Ownership and execution handoff
The parent created this clean linked worktree from `origin/hallucinario` specifically for this child: `feat/mydot-human-handoff-5dc06c8e1154`. All writes, including this plan, stay here. The parent owns the single DSH PR, review, CI, merge and deployment. This child implements, verifies and commits its branch; it must not create another worktree, push or create a PR. This follows the shared policy's helper-child merge-back contract.

## Scope and design resolution
Add a MyDot-owned request service, Session event/projection and native UI over existing Session/inbox; no new Task/Run database. Short-lived preparation concludes only its branch. Scoped waiting prevents unsolicited automatic rounds without resetting consumed budgets, pausing siblings or overriding explicit cancel/pause. Saved answers have stable delivery identity; durability barrier precedes receipt. Recover answer delivery after restart; claimed-but-unproven work remains unknown rather than silently repeated. Business responses never grant broader external-action authority.

Adopt a small opt-in owner-only Unix HTTP callback in the same Cordis plugin for ashiba server results, using Node standard libraries and fixed configuration rather than model/browser-selected destinations. No public listener, daemon, secret, registry package, notification or PC takeover is added. Official Codex mobile remains the generic Codex route.

## Interfaces and dependencies
The deep link carries requestId, requestRevision, caseId (survey), case (planning), source, sourceRevision, baseRevisionId, baseVersion and workflow (`independent-reference` or `assisted-correction`). The persisted result is `{schemaVersion:1,requestId,status,source:{caseId,sourceId,sourceRevision,manifestId},baseSurvey:{revisionId,version},survey:{revisionId,version},planning:null|{caseId,revisionId,headVersion},goldId:null|string}`; status is `saved|applied|deferred|needs-material`.

Optional MyDot config: `humanHandoffSocketPath` and `humanHandoffSurveyOrigin`, both empty/off by default. The origin must be a fixed loopback HTTP origin. Callback is `POST /human-requests/<requestId>/answers` with `{requestRevision,result}`. Before acceptance, GET `/api/survey/<caseId>/<sourceId>/handoffs/<requestId>` at the configured origin and require `{result:<same envelope>,current:{survey:true,planning:true}}`. The planning boolean is true when result.planning is null. Derive original Session/target from the recorded request. Compare original source and baseSurvey; permit only the expected handoff's own saved advancement. Stale, missing, unverifiable or unknown outcomes remain actionable states, not success. ashiba owns the authoritative endpoint and actual drawings/corrections.

## Sources and research
Existing MyDot `src/{index,types,control}.ts`; SessionStore.flush; agent inbox splice/admission; session-controller resolveAgent/resumeObserved; subagent continuation; goal-round-driver eligibility; architecture and defensive-pattern docs. The parent supplied a completed read-only seam audit. Node HTTP/Unix sockets and existing zod/schema/session primitives cover the domain requirements; no generic utility/package invention is needed. Relevant official OpenAI remote/app-server documentation was checked by the parent on 2026-11-11; transient resolved prompts do not prove business approval or execution.

## File responsibility and dependency order
1. MyDot request domain types, projection and tests: durable revision transitions, duplicate/stale refusal, explicit receipt/admission/outcome, replay.
2. MyDot host service and tests: preparation, serialized durable acceptance, targeted Session recovery, current-target verification and local callback safety. Reuse existing ownership/retention/inbox services and extension hooks.
3. Goal/subagent/session extension points only where necessary: waiting eligibility and cold ownership restoration; preserve existing consumed limits. Update owning docs/persistence acknowledgements/catalog/SDK expected output if those public types change.
4. MyDot snapshot, client store/Panel/locales/CSS and tests: pending reason/role/target/evidence/next action, answer states, draft retention, mobile layout.
5. Existing MyDot README and keyless shipped-profile Session snapshot: document the selected first workflow and conditional deferred choices. Add the smallest existing test overlay needed for a supported dsh-profile smoke.

## TDD and exact verification
Write failing focused tests before production code. Required cases: same receipt on duplicate, conflicting/stale submission refusal, failed or absent durability, lost response, crash after receipt, uncertain claim/admission, original child routing, pause/cancel/budget preservation, sibling progress, authoritative result mismatch, socket permissions/symlinks/live listener protection, UI draft retention.

Run focused `pnpm exec vitest run packages/experimental/mydot/tests` plus changed owner tests only. Run the keyless Session snapshot with `DSH_EXAMPLE_MODE=lib pnpm run test:snapshot apps/web/tests/mydot-human-handoff.snapshot.ts scripts/session-snapshot-corpus.corpus.ts`. Run relevant persistence generators and doc-sync if their inputs changed. Run `pnpm run build:artifacts` followed by `pnpm run build:check`. Use `pnpm install --frozen-lockfile` only if dependencies need preparation. Run the built dsh profile against a temporary test home and the feature overlay without a real model/API charge. Report the exact commands and actual results. Parent performs MCP browser QA.

## Risks, constraints and recovery
Do not weaken source association, auth, origin, Session persistence or build/test gates. Validate wire/durable JSON and branded cross-boundary IDs; typed same-process values need no redundant hostile-input wrappers. The Unix endpoint must live in a validated private owner directory; never overwrite a live or unknown listener or follow symlinks. Register startup/teardown through Cordis effects and drain accepted work. Default feature off and retained Session records provide a reversible disable path without deleting user data.

## Acceptance and assumptions
The technical first workflow must pass focused restart/duplicate/stale tests, supported built-profile smoke and build checks. The ashiba callback schema above is agreed with the parent and parallel ashiba worker; real cross-app observation remains to be done by the parent. Actual iPhone/cellular/IME and actual independent reviewer/project timing are human acceptance outside this child; never report those from fixture tests. Complete code and commit it here, then return branch/SHA, validation, exact callback interface and any factual remaining limitation.
