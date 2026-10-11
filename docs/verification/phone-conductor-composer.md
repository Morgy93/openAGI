# Phone-to-Conductor delivery checks

A responsive phone or main does not prove that the selected computer can read
or control Conductor. Check the target computer's current capability report,
then distinguish permission/locked-screen blocks, owner-presence waits,
thread-identity blocks, screenshot timeouts, and composer readback failures.
Never report a blocked, failed, or unconfirmed send as delivered.

The composer adapter reads nested editable text as the composer's value and
retains field-looking message text such as `URL:` and `Title:`. Screen summaries
exclude unsent composer descendants. Only known application placeholders may
establish emptiness or qualify for leftover-placeholder repair; repeated owner
text and partial placeholder prefixes remain drafts and are not overwritten.

Run `node --test test/fleet-ui-delivery.test.js` for fixture verification.
Tests cannot establish installation or live phone/device acceptance. Verify
that the target's installed source contains the corrected adapter, then use a
separately authorized harmless message in a selected test thread and confirm
exactly one transcript copy. Do not retry an uncertain send automatically.

## Remaining input boundary

Upstream app-scoped `set_value` has no compare-and-set contract for the expected
composer value. An owner-presence precheck does not atomically protect text
entered while an input call is queued. These parser corrections do not resolve
that dispatch race. Keep the existing approval, owner-presence, draft, identity,
and readback gates; do not claim unattended delivery is guaranteed safe until
conditional input dispatch is implemented and verified on the controlled Mac.
