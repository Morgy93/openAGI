# Model setup and navigation redesign

This updates PR #215. It preserves its installation and runtime packaging work.

The interface uses one navigation sidebar, restrained shared tokens, and a focused chat workspace. A three-step deterministic wizard connects and verifies a model before guided chat. Integrations, screen permissions, devices, and advanced configuration remain optional, separate setup paths.

## Acceptance

- [x] Connect an API model with only that provider's fields visible.
- [x] Connect an Ollama or compatible local server without a cloud key.
- [x] Offer Apple Intelligence with truthful availability on Mac and iOS.
- [x] Reject missing credentials, fallback echoes, and failed connections as setup success.
- [x] Verify the model before entering chat; preserve existing credentials on a rerun.
- [x] Exercise navigation, browser history, fresh guided chat, errors and narrow layouts.
- [x] Record focused tests, native compile evidence and screenshots. Exact-head CI is reported on PR #215.

Native model availability requires compatible hardware, OS, enabled Apple Intelligence and downloaded models. Browser fixtures cannot establish hardware acceptance.

## Verification evidence

- Focused regression set: 82 passed. After the final draft-preservation edit,
  the affected chat, setup and security tests passed (38), plus the guide,
  local-provider and context-trimming tests (9).
- Shared Apple model sources: `xcrun swiftc -typecheck` passed for macOS.
- Real Apple Foundation Models inference: a disposable native helper built
  from the shared bridge connected to the isolated runtime. The browser setup
  page verified `apple-foundation-models` successfully. The installed app was
  not changed. This does not establish packaged Mac or physical iPhone acceptance.
- Local-server UI verification used a disposable Chat Completions fixture at
  loopback port 43322. No cloud key, paid call, account connection, screen
  capture, computer action, or phone pairing was used.
- Browser walkthrough: choose/configure/verify/start, missing key, unreachable
  server and retry, guided draft/send, Back/Forward, draft retention across tabs,
  narrow navigation, Escape dismissal, no horizontal overflow and dark appearance.
- Native Mac and iOS compilation/tests, full runtime regression and packaged
  Windows/Linux smoke checks run on the final PR head in GitHub Actions.
- CI follow-up: updated legacy navigation assertions, the model-setup handoff
  smoke check, and the iOS model greeting expectation for availability reporting.
  All 55 affected JavaScript tests and disposable source startup passed locally.

| Surface | Evidence | Verified state |
| --- | --- | --- |
| Model setup | [Choose](onboarding-redesign/model-choice.png) | Only model selection before credentials |
| Getting started | [Guides](onboarding-redesign/guides.png) | One recommended first step, optional guides and collapsed details |
| Chat | [Guided draft](onboarding-redesign/guided-chat.png) | One selected guide, editable draft, no duplicate welcome choices |
| Narrow workspace | [Navigation](onboarding-redesign/narrow-navigation.png) | Sidebar menu at 390px; selection and Escape dismiss it |

The local standalone walkthrough and additional error/native-model screenshots
are in the Codex artifact `onboarding-redesign/walkthrough.html`.
