# Supervisor actionable follow-up

Local repairs on spencer/supervisor-actionable. No findings declined.

## Findings and contract gaps

- Paced Needs a push rows have a separate pushPreview containing the full message. Server, Mac, Android and web use it for Push now.
- Push now sends the stored preview verbatim, including judge rewrites. The preview is not clipped to the automatic decision's 500-character excerpt.
- A per-thread send guard blocks overlapping pushes; ledger checks block the same message until the agent replies. Live state clears sent previews and exposes pushing. Web keeps pending keys through polling.
- Any open question, including one held for review, blocks a push. Owner answers still go first.
- Muting immediately moves a Waiting on you row to Quiet; live watch counts update. Unmuting restores the scan's watch and current questions.
- Snapshot lastAgentText is redacted before clipping, including state readback of older snapshots. askContext and pushPreview are documented in contracts.js.
- Mac risky asks show full askContext before answer options in cards and expanded Watching rows. Expanded risky cards also retain all the words.
- Risk classification uses the ask's title, body and options rather than incidental report context; explicit merge asks remain risky.
- Android and web filter the dead open thread answer option. Android instructs the owner to open unsupported chat links on their Mac, without implying that tapping an answer opens an app remotely.
- Linkless Conductor-hosted Codex labels and notes name the workspace.
- Remote thread detail treats only HTTP 404 as missing; other computer errors remain errors.
- Mac connection-refused, unknown-host and offline errors do not imply that a request is still running. Existing detached readback and automatic banner clearing remain in place.

## Verification

The first full Node run completed 2355 passing assertions and one skip, but cancelled node-heartbeat-sender.test.js at its 180-second file timeout. Its six assertions also passed in isolation before the process timed out. A focused delayed-heartbeat test proved that a heartbeat completing after close restarted the bridge. A closing guard now prevents restarting either the bridge or node worker. All seven tests in that file passed and the process exited in about three seconds. This was a reproducible shutdown defect, not a flake.

- Node 22.21.1: full suite passed 2357 tests total: 2356 passed, one skipped, zero failures or cancellations (477.7 seconds). Focused fleet tests passed; the repaired heartbeat file passed twice alone.
- Mac: swift build succeeded; swift test passed 108 tests, zero failures. Existing updater Swift 6 actor-isolation warning remains.
- Android: testDebugUnitTest passed 310 tests, zero failures/errors/skips; assembleDebug succeeded.
- No live daemon actions or device UI acceptance were performed. Phone links without a local handler require opening the named chat manually on the Mac.

The first post-repair full run was interrupted by an external time limit. The completed rerun above used the exact requested full-suite command.

## Files changed

- mac/Sources/OpenAGI/AppState.swift
- mac/Sources/OpenAGI/Overlay/Fleet/FleetModels.swift
- mac/Sources/OpenAGI/Overlay/Fleet/FleetRowParts.swift
- mac/Sources/OpenAGI/Overlay/Fleet/FleetThreadDetail.swift
- mac/Sources/OpenAGI/Overlay/Fleet/FleetWatching.swift
- mac/Sources/OpenAGI/Overlay/Fleet/SupervisorSection.swift
- mac/Sources/OpenAGI/Overlay/Fleet/WatchingList.swift
- mac/Tests/OpenAGITests/FleetThreadDetailTests.swift
- mobile/android/app/src/main/kotlin/sh/openagi/mobile/protocol/FleetModels.kt
- mobile/android/app/src/main/kotlin/sh/openagi/mobile/ui/SupervisorScreen.kt
- mobile/android/app/src/main/kotlin/sh/openagi/mobile/ui/WatchFormat.kt
- mobile/android/app/src/test/kotlin/sh/openagi/mobile/ui/WatchFormatTest.kt
- src/fleet/classify.js
- src/fleet/contracts.js
- src/fleet/page.js
- src/fleet/remote.js
- src/fleet/supervisor.js
- src/hosted-interface.js
- test/fleet-contracts.test.js
- test/fleet-page.test.js
- test/fleet-remote.test.js
- test/fleet-supervisor.test.js
- test/node-heartbeat-sender.test.js
- docs/verification/2026-10-14-supervisor-actionable.md
