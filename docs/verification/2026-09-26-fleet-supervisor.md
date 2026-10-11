# Fleet supervisor continuation verification

Preserved branch `spencer/supervisor-agent-mini-app` and PR #112. The continuation
uses Codex and keeps the existing observe-first prototype scope.

## Material findings addressed

The latest review was read through all available pages. Existing fixes on
`fc07296` cover isolated CLI state, cap recovery, model-limit choices, structured
question detection, complete BuildBot3 probes, upstream LB failures, failed
background attempt accounting, outreach closure, risky permission context, and
unknown mergeability. Their fleet regressions pass.

This continuation fixes:

- Undelivered answers disappearing for 24 hours: questions remain open when a
  route is absent or delivery fails. Partial cap recovery tracks successful
  recipients, allowing the remaining threads to be retried.
- Structured choices being replaced or truncated: supported original labels
  survive parsing, classification, policy, storage, and owner delivery. Free-text
  and multiple prompts direct the owner to the original thread.
- Shared login/disk questions losing stopped threads: each thread retains its
  own recovery question and delivery target.
- Exact pushed heads being marked unpushed because the branch tracks main.
- Old proposals sending after switching to Observe.
- Negative PR lookup refreshes starving later branches indefinitely.
- Stopped CI watchers waiting indefinitely when no checks exist on the head.
- Relay refusals containing DONE being misreported as successful delivery.

These affect ordinary recovery/readiness or the explicit observe boundary,
with impact at least 6/10 for affected users. Lost answers and discovery/wait
starvation do not self-repair on the next scan; opening the thread and retrying,
manual branch discovery, or manual agent continuation was previously required.
No additional speculative hardening or release work was added.

## Verification

- Node 22 focused changed-area tests: 124 passed.
- All fleet tests, including HTTP authentication/origin gates: 262 passed.
- Real read-only scan: 199 discovered, 94 in scope, 25.3 seconds, no source errors.
  BuildBot3 reachable; load balancer health HTTP 200. No agent or phone sends.
- Browser QA uses the current workspace server on 127.0.0.1:43311 with an
  isolated `.context/fleet-qa-data` directory, timer disabled, mode Observe.
- Hosted CI remains the full package/backend and G2 overlay verification gate.

The prototype does not mirror fleet questions onto physical G2 glasses or the
Distiller main. Delivery adapters are verified with isolated tests; this QA does
not send messages to real coding sessions. Desktop-held Codex writer locks and
non-live Conductor sessions still require opening the original thread.


## PR #113 update on 2026-10-10

The branch now includes `main` at `fcd6a92`. Fleet dismissal keeps the owner action,
actor, and note when a refresh overlaps the response. A failed dismissal keeps
the outreach question open. A successful refresh closes questions from a computer
that is no longer selected. The update keeps main's five-minute delivery budget
and offline glasses dismissal replay. Android allows 340 seconds for a response.

The iOS retry checks now use the shared conversation model. An interrupted turn
cannot be sent again through the retry button. This check is saved in the chat
cache and remains after an app restart. A reply received before a stream error
remains visible. Cancelled tasks have no completion button in the row or detail.

The focused Fleet and outreach tests passed: 33 tests on Node 22.21.1. The changed
Swift files passed parsing. Hosted backend/G2 and iOS CI must pass on the new PR
head before merge. No release, installation, or device test is part of this merge.
