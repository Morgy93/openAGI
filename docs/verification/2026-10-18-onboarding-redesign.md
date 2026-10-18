# Model setup and navigation redesign

This updates PR #215. It preserves its installation and runtime packaging work.

The interface uses one navigation sidebar, restrained shared tokens, and a focused chat workspace. A three-step deterministic wizard connects and verifies a model before guided chat. Integrations, screen permissions, devices, and advanced configuration remain optional, separate setup paths.

## Acceptance

- [ ] Connect an API model with only that provider's fields visible.
- [ ] Connect an Ollama or compatible local server without a cloud key.
- [ ] Offer Apple Intelligence with truthful availability on Mac and iOS.
- [ ] Reject missing credentials, fallback echoes, and failed connections as setup success.
- [ ] Verify the model before entering chat; preserve existing credentials on a rerun.
- [ ] Exercise navigation, browser history, fresh guided chat, errors and narrow layouts.
- [ ] Record focused tests, native compile evidence, screenshots and exact-head PR checks.

Native model availability requires compatible hardware, OS, enabled Apple Intelligence and downloaded models. Browser fixtures cannot establish hardware acceptance.
