# Paperclip: scoped transactional Stitch completion gate

The Stitch completion extension implements a pre-write check
in issueService.update, inside the transaction that locks the current
issue row. When configured, a design issue cannot transition to done
without a valid, designer-authored STITCH_EVIDENCE comment.

A canonical evidence line is:

    STITCH_EVIDENCE: {"project_id":"projects/PROJECT","screen_id":"screens/SCREEN"}

The server calls the local Stitch MCP at 127.0.0.1:9215/mcp,
using the official get_screen resource name
projects/PROJECT/screens/SCREEN, and fails closed on missing or
unverifiable screens. The guard also prevents creation of an initially
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
