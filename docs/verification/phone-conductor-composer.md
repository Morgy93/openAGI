# Phone-to-Conductor delivery checks

A responsive phone or main does not prove that the selected computer can read
or control Conductor. Check the target computer's current capability report,
then distinguish permission/locked-screen blocks, owner-presence waits,
thread-identity blocks, screenshot timeouts, and composer readback failures.
Never report a blocked, failed, or unconfirmed send as delivered.

The composer adapter reads nested editable text as the composer's value and
retains literal message text such as `URL:`, `Value:`, and `Secondary Actions:`.
Screen summaries exclude unsent composer descendants. The known Codex empty
representation (a doubled parent placeholder and a single placeholder child)
is recognized as empty. Other child text remains a draft.

## Input and draft preservation

New messages use Open Computer Use's `type_text`, not whole-field `set_value`.
Replacing a composer after an idle precheck can erase edits that arrive while
the call is queued. Append input preserves intervening text; delivery requires
an exact message readback before it can click Send or press Return. A mismatch
stays unsent. Presence, thread identity, approvals and input-in-flight gates
remain enforced. An exact leftover message can be sent without retyping; a
placeholder-prefixed or otherwise edited draft is not replaced or cleared.

This removes the unconditional whole-field overwrite. It does not establish
atomic control of arbitrary apps or guarantee that input cannot fail. Upstream
app-agent calls can outlive their proxy, so uncertain input must not be retried
blindly. A screen-read failure is a separate issue from a permissions grant.

## Verification boundary

Run `node --test test/fleet-ui-delivery.test.js test/fleet-tools.test.js test/ocu-transport.test.js` for fixture verification. Tests cannot establish
installation or live phone/device acceptance. Verify the selected computer's
installed adapter, then use a separately authorized harmless message in a
selected test thread and confirm exactly one transcript copy.

The paired computer's local session store may not contain the phone's chat:
shared Supervisor history is retained by the main. Read it with an authorized
owner or phone session; a generic computer-node credential does not grant that
history scope. A background app-open receipt only establishes a running app,
not a focused window or a successfully submitted message.
