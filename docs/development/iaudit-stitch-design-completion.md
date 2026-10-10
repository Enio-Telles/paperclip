# Paperclip: scoped transactional Stitch completion gate

The Stitch completion extension implements a pre-write check
in issueService.update, inside the transaction that locks the current
issue row. When configured, a design issue cannot transition to done
without either a valid, designer-authored STITCH_EVIDENCE comment
OR an approved alternative-design work product and its receipt.

A canonical evidence line is:

    STITCH_EVIDENCE: {"project_id":"projects/PROJECT","screen_id":"screens/SCREEN"}

## Reviewed alternative (fallback)

Stitch is preferred, but not mandatory when unavailable, out of quota,
unsupported, or when the requester chooses a different design route.
The Design Specialist may instead use Figma (if connected), AGY-Carine,
an HTML/CSS/React frontend with a browser screenshot, or reviewed manual design.
The agent records a reason, preview/QA artifacts and a real work-product UUID
in a Paperclip comment:

    DESIGN_FALLBACK_EVIDENCE: {"reason":"stitch_unavailable","method":"agy-carine","work_product_id":"WORK_PRODUCT_UUID"}

Supported reasons: stitch_unavailable, quota_exceeded, integration_error,
unsupported_request and user_choice. Supported methods/providers: figma,
agy-carine, frontend-code and manual.

The work product MUST belong to the same issue and company and have matching
provider, status completed, reviewState approved and a valid https preview URL
(or local loopback preview). Unsupported/unreviewed claims cannot complete the task.
Only the Design Specialist can author either receipt. A reviewed alternative
does NOT need a Stitch screen ID. No automated call to a paid model is required
by the gate. Review approval remains part of the normal Paperclip workflow.

The server calls the local Stitch MCP at 127.0.0.1:9215/mcp,
using the official get_screen resource name
projects/PROJECT/screens/SCREEN, and fails closed on missing or
unverifiable screens when no reviewed fallback exists. The guard also
prevents creation of an initially
completed design issue. Other agents and companies are unaffected.

## Opt in at deployment

Set BOTH of the following in the Paperclip server process environment:

- PAPERCLIP_STITCH_GATE_COMPANY_ID: UUID of the company
- PAPERCLIP_STITCH_GATE_AGENT_ID: UUID of the Design Specialist

The feature is disabled by default. A checkout containing these source files
does NOT mean the currently running Paperclip process has this feature.
Build and deploy the matching server version, verify CLI/UI compatibility,
back up the embedded database, and restart safely before enabling.

The gate is server-service-level (covers service update and create
calls); it does not protect against SQL writes that bypass issueService.
The row lock is held for the MCP request (3.5-second network timeout per
step). Operators should check server latency before enabling under load.
Tests use a mocked MCP transport and do not modify the live Paperclip DB.
No secrets or fiscal data should be added to evidence comments.

Run focused tests:

    pnpm exec vitest run server/src/services/stitch-completion-gate.test.ts

The deployed extension is distinct from the existing read-only IAudit audit
service; the latter continues detecting historical/policy violations
without changing status.
