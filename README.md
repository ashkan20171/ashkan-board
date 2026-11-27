
## Database migrations on Windows

Phase 64 improves local migration startup by automatically loading a project-root `.env` file before `npm run db:migrate`.

1. Copy `.env.example` to `.env`.
2. Set `DATABASE_URL` to your PostgreSQL connection string, for example:
   `DATABASE_URL=postgresql://ashkan:change-me@localhost:5432/ashkan_board`
3. Make sure PostgreSQL is running and the database/user exist.
4. Run:
   `npm run db:migrate`

`.env` is ignored by Git and should not be committed.

If you prefer a one-off Windows CMD session, you can also run:
`set DATABASE_URL=postgresql://ashkan:change-me@localhost:5432/ashkan_board&& npm run db:migrate`

# AshkanBoard — Phase 30

Phase 11 connects the React workspace to the authenticated API introduced in Phase 10. The application now requires an account to enter the board and loads/saves tickets through workspace-scoped server endpoints.

## Phase 11 changes

- Login and registration screens in Persian/English.
- Registration validation (valid email, name, password of at least 12 characters) and login through the API.
- Access-token session check on reload and sign-out.
- Workspace list loaded from the authenticated API.
- Workspace creation persisted through the server.
- Ticket list, create, update, status transitions, bulk status changes, and delete use authenticated API calls.
- Extended ticket fields are preserved by the API: type, due date, assignee, project, QA tests, tags, comments, estimates, time spent, dependencies, and recurrence.
- Existing board views, QA Gate, filters, planning views, and client-side activity/notification history remain available.
- API failures are surfaced in the interface rather than silently pretending that server writes succeeded.

## Run locally

Requirements: Node.js 20+.

1. Copy `.env.example` to `.env` and provide a unique random `JWT_SECRET` with at least 32 characters.
2. Export the environment variables in your shell (Node does not load `.env` automatically):

```bash
export JWT_SECRET='replace-with-a-random-secret-at-least-32-characters-long'
export CORS_ORIGIN='http://localhost:5173'
export DATA_FILE='./data/ashkan-board.json'
export VITE_API_URL='http://localhost:4000'
```

3. Install frontend dependencies with `npm ci`.
4. Start the API in one terminal: `npm run api`.
5. Start Vite in another terminal: `npm run dev`.
6. Register an account in the app. Registration creates the initial workspace.

API health check: `GET http://localhost:4000/api/health`.

## API routes

| Method | Route | Description |
|---|---|---|
| POST | `/api/auth/register` | Register and create initial workspace |
| POST | `/api/auth/login` | Authenticate and issue access token |
| GET | `/api/auth/me` | Validate current session |
| GET | `/api/workspaces` | List current user's workspaces |
| POST | `/api/workspaces` | Create a workspace for current user |
| GET | `/api/workspaces/:workspaceId/tickets` | List workspace tickets |
| POST | `/api/workspaces/:workspaceId/tickets` | Create ticket |
| PATCH | `/api/workspaces/:workspaceId/tickets/:ticketId` | Update ticket |
| DELETE | `/api/workspaces/:workspaceId/tickets/:ticketId` | Delete ticket |

Send the access token as `Authorization: Bearer <token>`.

## Tests

Run the API integration suite with:

```bash
npm run test:api
```

The tests cover registration, authentication, workspace creation, ticket creation and update, workspace isolation, and permission enforcement.

## Remaining production work

This is a connected development foundation, not a production-ready multi-tenant deployment. The JSON-file repository is single-process only; the PostgreSQL migration file is a schema reference and PostgreSQL is not yet wired. Access tokens are stored in localStorage for development convenience and are exposed to XSS risk. Refresh-token rotation/revocation, email verification, password reset, real member invitation/role administration, PostgreSQL repository/migration runner, server-side audit history, secure cookie strategy, CSRF protection where applicable, HTTPS, secret management, backup/restore, and deployment monitoring remain future work.

Activity/notification feed, milestones, saved views, and some planning metadata remain browser-local in this phase; the authoritative ticket records are now server-backed. Existing Local Storage tickets are not automatically imported, to avoid accidentally uploading data without an explicit migration/confirmation flow.

# Phase 12 — Database & Advanced Security

## Added in Phase 12

- Refresh-token sessions with rotation, 30-day expiry, family-wide revocation on logout, and replay detection.
- Client-side refresh flow: one in-flight refresh request is shared and a failed refresh clears the stored session.
- Password-reset token flow: tokens are single-use, expire after 15 minutes, and a successful reset revokes all existing refresh sessions.
- Workspace invitations for an existing account, invitation acceptance bound to the invited email, and seven-day expiry. In development, the API returns the invitation token so the flow can be tested; production requires a real email delivery integration.
- Workspace member listing, add/remove, and role changes enforced by server-side permissions. The owner role cannot be removed or changed through these routes.
- Server-side audit events for ticket create/update/delete and membership/invitation changes.
- PostgreSQL mode selected by `DATABASE_URL`; `server/migrate.mjs` applies ordered SQL migrations.
- The API health response reports `json-file` or the transitional `postgres-jsonb+normalized-projection` persistence mode.

## PostgreSQL setup

The PostgreSQL adapter stores the application aggregate in a locked JSONB row (`ashkan_app_state`) and transactionally rebuilds normalized relational projection tables. Reads still use the aggregate; the relational projection is not yet the active per-entity repository path.

1. Install the optional PostgreSQL driver: `npm install pg`.
2. Set `DATABASE_URL` and, when required, `PG_SSL=true` in the environment.
3. Run `npm run db:migrate`.
4. Start the API with `npm run api`.

If `DATABASE_URL` is absent, the development JSON-file adapter is used. Do not use the JSON-file adapter for multi-process production deployments.

## Security and delivery limitations

- Refresh tokens are currently stored in browser localStorage for compatibility with the existing client. A production deployment should move them to Secure, HttpOnly, SameSite cookies and add the corresponding CSRF strategy.
- Password-reset and invitation flows return tokens only in development. A production email provider and delivery templates must be configured before enabling those workflows publicly.
- Password-reset token generation and server-side invalidation are implemented; email verification is not implemented in this phase.
- Invitations require the target email to already have an AshkanBoard account; external email invitations and signup handoff remain future work.
- The PostgreSQL adapter currently uses a JSONB aggregate row with transaction locking and maintains a normalized relational projection in the same transaction. Reads still use the aggregate; the relational projection is not yet the runtime source of truth.
- API integration tests run with the JSON-file adapter. PostgreSQL migrations and runtime connectivity require a configured PostgreSQL service and the optional `pg` package.

## Phase 12 validation

`node --check` passed for the API, security, store, and migration modules. `npm run test:api` passed: 2 test cases covering workspace isolation/permissions, refresh rotation and replay detection, password reset, and audit logging. Frontend lint/build could not be run because frontend dependencies are not installed in this environment.


# Phase 13 — Server Notifications & Safe Data Import

## Added in Phase 13

- Workspace-scoped notification inbox API: `GET /api/workspaces/:workspaceId/notifications`.
- Per-user unread counts and read state; `PATCH .../notifications/:notificationId` marks one notification read and `PATCH .../notifications/read-all` marks the inbox read.
- Ticket create/update events create inbox notifications for other workspace members; the actor does not receive their own notification.
- Ticket import API supports a dry-run validation and a commit mode: `POST /api/workspaces/:workspaceId/imports/tickets`.
- Import batches require a caller-provided `batchKey`; repeated commits for the same workspace/key are idempotent and do not duplicate tickets.
- Import validates the full batch before writing; invalid rows prevent commit. Maximum batch size is 2,000 tickets.
- New SQL migration `003_notifications_imports.sql` adds normalized schema groundwork for notifications and import batch keys.
- API integration tests cover inbox visibility, unread/read behavior, import dry-run, validation, commit, and duplicate prevention.

## Phase 13 API examples

```http
GET /api/workspaces/{workspaceId}/notifications
Authorization: Bearer <access-token>

PATCH /api/workspaces/{workspaceId}/notifications/read-all
Authorization: Bearer <access-token>

POST /api/workspaces/{workspaceId}/imports/tickets
Authorization: Bearer <access-token>
Content-Type: application/json

{
  "mode": "dry-run",
  "batchKey": "legacy-export-2026-01",
  "tickets": [{ "id": "old-1", "title": "Imported task", "priority": "High" }]
}
```

Use `mode: "commit"` only after reviewing the dry-run result. Keep the same `batchKey` for retries so an uncertain network response cannot create duplicate imports.

## Phase 13 validation

`node --check server/app.mjs` and `node --check server/store.mjs` passed. `node --test server/tests/*.test.mjs` passed all 3 test cases. PostgreSQL migration 003 is added but was not executed because no PostgreSQL service/credentials are configured in this environment. The current PostgreSQL adapter remains the transitional JSONB aggregate from Phase 12; this phase does not claim normalized runtime repositories or frontend notification/import screens. Frontend dependencies are not installed here, so frontend lint/build remain unverified.

# Phase 15 — Team Collaboration Foundations

## Added in Phase 15

- Durable, workspace-scoped ticket discussion threads stored independently from ticket payloads.
- Authenticated comment list/create/delete endpoints. Members can delete their own comments; workspace administrators can moderate comments.
- Comment author identity is resolved from the server-side user record.
- Mentions are validated against actual workspace membership; mentioned users receive server-side notifications. If no mention is selected, other workspace members receive a general comment notification.
- Ticket deletion also removes its comments in the JSON aggregate store; the PostgreSQL schema uses cascading foreign keys.
- Authenticated profile display-name update endpoint (`PATCH /api/auth/me`).
- Task detail dialog loads comments from the API and refreshes the thread every 10 seconds. Workspace ticket and notification summaries refresh every 15 seconds to provide near-real-time collaboration without a WebSocket dependency.
- Migration `004_ticket_comments.sql` adds the normalized comments table and thread index.

## Phase 15 API

- `GET /api/workspaces/:workspaceId/tickets/:ticketId/comments`
- `POST /api/workspaces/:workspaceId/tickets/:ticketId/comments` with `{ "body": "...", "mentions": ["user-id"] }`
- `DELETE /api/workspaces/:workspaceId/tickets/:ticketId/comments/:commentId`
- `PATCH /api/auth/me` with `{ "name": "Display name" }`

Comments are limited to 5,000 characters. Mention IDs not belonging to the workspace are ignored. The API returns the author profile with each comment.

## Phase 15 validation

- `node --check` passed for server modules and the API client.
- `node --test server/tests/*.test.mjs` passed all 4 integration tests, including the new comment thread, mention notification, validation, and profile update coverage.
- PostgreSQL migration 004 is included but was not run because this environment has no configured PostgreSQL service.
- Frontend build and ESLint remain unverified because dependencies are not installed in this environment.

## Known limitations

- Collaboration updates use authenticated polling (10–15 seconds), not WebSockets or a push transport.
- File attachments and outbound email delivery are not included in Phase 15.
- PostgreSQL runtime persistence remains the transitional JSONB aggregate adapter described in Phase 12; migration 004 is schema groundwork until normalized repositories are completed.

# Phase 16 — Live Collaboration, Presence & Attachments

## Added in Phase 16

- Authenticated Server-Sent Events (SSE) endpoint per workspace: `GET /api/workspaces/:workspaceId/events`. Events are emitted for ticket changes, comments, attachments, and presence heartbeats. SSE was selected as a lightweight server-push transport; this phase does not claim WebSocket support.
- Online presence heartbeat: `POST /api/workspaces/:workspaceId/presence`; `GET` returns members seen within the last 60 seconds. The React client sends a heartbeat every 20 seconds and displays the online count and live-connection state.
- Ticket attachments: authenticated list, upload, download, and delete endpoints. The React task dialog supports upload/download/delete.
- Upload allowlist: PDF, PNG, JPEG, WebP, plain text, and CSV; maximum 5 MB per file. Files are stored outside the public web root with generated storage names and restrictive filesystem permissions. Metadata is workspace/ticket scoped.
- Ticket deletion removes associated attachment metadata and stored files.
- OpenAPI documents the new event, presence, and attachment endpoints.
- API integration test covers workspace membership, SSE connection/event delivery, online presence, attachment upload/download, and rejection of unsupported MIME types.

## Phase 16 configuration

`UPLOAD_DIR` optionally selects the private attachment storage directory. It defaults to `./data/uploads`. Back up this directory together with the application data; attachment metadata alone is not sufficient to restore file contents.

## Phase 16 validation

- `node --check server/app.mjs`, `node --check server/tests/api.test.mjs`, and `node --check src/api/client.js` passed.
- `node --test server/tests/*.test.mjs` passed all 5 integration tests.
- The React/Vite build and ESLint were not run because frontend dependencies are not installed in this environment.

## Phase 16 deployment considerations

- SSE and presence currently use in-memory connection tracking and the JSON aggregate store. Run a single API process for this development implementation; multi-instance deployments need a shared pub/sub service and shared presence store.
- Uploaded files currently use local private disk storage. Production deployments should use private object storage, malware scanning, retention policies, and quotas.
- MIME type is allowlisted and downloads use `Content-Disposition: attachment` plus `X-Content-Type-Options: nosniff`; a production hardening pass should also inspect file signatures and scan uploaded content.
- Online presence expires after 60 seconds without a heartbeat. This is an approximate activity signal, not a guarantee that a person is actively viewing the app.
- The client keeps authenticated polling as a fallback/safety refresh. The live event stream supplements it; this is not a full replacement for all synchronization paths.


# Phase 17 — Content Editing, File Preview & Profile Center

## Added in Phase 17

- Ticket description editor with Markdown shortcuts for bold, italic, headings, lists and inline code.
- Separate write and preview modes. The preview renders text as React nodes; raw HTML is not executed.
- Description limit raised to 5,000 characters in the UI (the API already accepts up to 10,000).
- Authenticated inline preview for PDF and image attachments. The download endpoint defaults to `Content-Disposition: attachment`; `?inline=1` is honored only for the allowlisted PDF/image MIME types.
- Preview files are fetched with the user's bearer token and displayed from a temporary object URL that is revoked when the preview closes.
- Profile center in the top bar, showing account email and allowing the user to update the display name through the existing authenticated `PATCH /api/auth/me` endpoint.
- Responsive styling for the editor, preview modal and profile center, matching the existing theme tokens.

## Phase 17 validation

- API integration suite includes checks that ordinary attachment downloads remain attachments and allowlisted PDF preview requests use inline disposition.
- Server/API syntax checks and JSX/TSX parser checks are performed for this release.
- No new runtime dependency was introduced.

## Scope notes

- The editor stores Markdown text in the existing ticket description field; it does not introduce a rich HTML document schema.
- Image/PDF preview uses browser-native rendering. Other file types remain download-only.
- Profile editing currently supports display name only. Email address, password changes, avatar upload and MFA management are not part of this phase.
- Email delivery, S3/object storage, normalized PostgreSQL repositories and WebSocket transport remain future work; this phase does not claim those are implemented.


# Phase 19 — Normalized PostgreSQL Projection & Data Integrity

## Added in Phase 19

- Migration `006_normalized_runtime.sql` adds durable relational tables for refresh tokens, password-reset tokens, invitations, audit events, attachments and online presence, with foreign keys, uniqueness/check constraints and query indexes.
- Added `server/normalized-repository.mjs` to map the existing domain aggregate into relational records using parameterized SQL. Ticket-specific fields remain in a JSONB `extra` column while core ticket fields are relational.
- PostgreSQL writes now update the compatibility aggregate and rebuild the normalized relational projection inside the same database transaction. If either write fails, the transaction rolls back.
- `npm run db:migrate` performs a transactional backfill from the existing `ashkan_app_state` snapshot after applying ordered migrations. This preserves existing data while populating the relational projection.
- Health/readiness metadata identifies the transitional `postgres-jsonb+normalized-projection` mode rather than claiming a completed repository cut-over.
- Added a repository mapping test for dependency-safe deletion order and ticket-extra serialization.

## Phase 19 architecture boundary

The JSONB aggregate remains the source of truth for application reads and service-layer mutations. The normalized tables are a transactionally maintained relational projection, not yet the active read path. The current projection is rebuilt from the full aggregate on each write, which is intentionally a migration bridge for small/medium datasets and is not the final high-throughput design. Phase 21 begins the cut-over with a direct normalized ticket-query path; subsequent phases should move the remaining route/service operations to per-entity repositories and incremental SQL writes before removing the aggregate row.

## Phase 19 validation

- `node --test server/tests/*.test.mjs` includes the normalized projection mapper test.
- PostgreSQL migration and live transaction behavior require a configured PostgreSQL service and are not claimed as end-to-end verified in this environment.
- Docker image build and full frontend build are not claimed unless run in the target environment.

---

# Phase 18 — Production Foundation & Operations

## Added in Phase 18

- Docker API image based on Node.js 22 Alpine, running as the unprivileged `node` user.
- Docker Compose stack with PostgreSQL 17, persistent database and private upload volumes, dependency health checks, API health checks, and automatic ordered SQL migrations at container startup.
- Production startup validation: a unique JWT secret of at least 32 characters, `DATABASE_URL`, `CORS_ORIGIN`, and `APP_BASE_URL` are required in production mode.
- Readiness endpoint: `GET /api/health/ready`. In PostgreSQL mode it opens a short-lived connection and checks the database; dependency failures return HTTP 503. `GET /api/health` also reports uptime and whether email credentials are configured.
- Structured JSON request logs with request ID, HTTP method, path, status, and duration. Sensitive request bodies, authorization headers, and query strings are not logged.
- Additional baseline response headers and graceful shutdown on SIGINT/SIGTERM.
- Resend-compatible outbound email adapter using the provider HTTP API. Password reset and workspace invitation emails are sent only when both `EMAIL_API_KEY` and `EMAIL_FROM` are configured. Delivery failures are logged without returning secrets or reset tokens to production clients.
- Expired/unused password-reset tokens for a user are pruned when a new reset request is created.
- Migration `005_runtime_indexes.sql` adds a GIN index to the transitional JSONB aggregate for future containment-based migration tooling.

## Production deployment with Docker Compose

1. Copy `.env.production.example` to `.env` and replace every placeholder. Use URL-safe values for `POSTGRES_PASSWORD` (for example, generate a hex string) because Compose injects it into `DATABASE_URL`.
2. Generate a unique JWT secret with `openssl rand -base64 48` and set the public frontend origin and base URL.
3. Configure `EMAIL_API_KEY` and `EMAIL_FROM` if password-reset and invitation emails should be delivered. Without these values, email delivery remains disabled; development token behavior is not exposed in production.
4. Start the stack with `docker compose up -d --build`.
5. Verify `http://localhost:4000/api/health` and `http://localhost:4000/api/health/ready`.

The Compose stack runs the API only; serve the existing Vite-built frontend from a static web server/CDN and set `CORS_ORIGIN` and `APP_BASE_URL` to that frontend's HTTPS origin. Put the API behind an HTTPS reverse proxy in a real deployment. Do not expose PostgreSQL publicly.

## Environment variables

- `POSTGRES_PASSWORD`, `DATABASE_URL`, `PG_SSL`, `PG_POOL_MAX`: PostgreSQL connection and pool configuration.
- `JWT_SECRET`: unique secret; production startup rejects missing or placeholder values.
- `CORS_ORIGIN`: exact frontend origin allowed by the API.
- `APP_BASE_URL`: frontend base URL used to generate password reset and invitation links.
- `EMAIL_API_KEY`, `EMAIL_FROM`, `EMAIL_PROVIDER_URL`: optional Resend-compatible email delivery. Provider URL defaults to `https://api.resend.com/emails`.
- `UPLOAD_DIR`: private local attachment storage. Compose persists it in a named volume.

## Phase 18 validation and limitations

- All 6 API integration tests pass, including a mocked outbound email provider test.
- `node --check` passes for the API, email adapter, store, and migration runner.
- Docker image build and live PostgreSQL migration were not run in this environment; Docker availability and a PostgreSQL service were not available for end-to-end verification.
- PostgreSQL runtime persistence remains transitional: the JSONB aggregate is authoritative, while Phase 19 adds a transactionally maintained relational projection. This is not yet a full per-entity repository cut-over.
- Email is provider-integrated but actual delivery requires valid credentials, a verified sender/domain, and a reachable provider endpoint.
- Attachments still use private local disk storage. Multi-instance SSE/presence coordination and object storage are not implemented here.

# Phase 20 — Relational Ticket Query Path

## Added in Phase 20

- Added `GET /api/workspaces/{workspaceId}/tickets/query` with server-side pagination (`page`, `pageSize`), bounded text search (`search`), status/priority filters, and allowlisted sorting (`sort`, `direction`). Page size is capped at 100 and responses include `total`, `totalPages`, `hasNext`, and `hasPrevious` metadata.
- Added `listNormalizedTickets()` to query the relational `tickets` table directly. SQL values are parameterized; sort columns and directions are selected from strict allowlists, never interpolated from arbitrary user input.
- Added migration `007_ticket_query_indexes.sql` with workspace-scoped indexes for common ticket sort/filter patterns.
- Added `api.queryTickets(workspaceId, params)` to the frontend API client so the UI can adopt server paging without changing the existing full-list API contract.
- Added `PERSISTENCE_MODE=normalized` as an opt-in PostgreSQL ticket-read path. The health endpoint reports the transitional state accurately.
- The endpoint also works in JSON-file/development mode using the same filters and pagination contract, making it testable without PostgreSQL.

## Phase 20 architecture boundary

This is an incremental cut-over, not a claim that all entities are now repository-backed. In `PERSISTENCE_MODE=normalized` with `DATABASE_URL` configured, the new query endpoint reads ticket rows from PostgreSQL's normalized `tickets` table. Authentication, workspace membership, and existing write paths still use the JSONB aggregate; writes continue to update the normalized projection transactionally. Other routes (comments, attachments, notifications, invitations, etc.) remain on their existing compatibility path. Run all migrations and the backfill before enabling this mode. The existing `GET /tickets` endpoint remains unchanged for backward compatibility.

## Enable the normalized ticket query path

1. Ensure PostgreSQL is configured and the project dependencies (including `pg`) are installed.
2. Run `npm run db:migrate` to apply migrations through `007_ticket_query_indexes.sql` and backfill the relational projection.
3. Set `PERSISTENCE_MODE=normalized` and restart the API.
4. Call `GET /api/workspaces/{workspaceId}/tickets/query?page=1&pageSize=25&status=todo&sort=createdAt&direction=desc`.

## Phase 20 validation and limitations

- API integration tests verify search/filter/sort/pagination behavior in JSON-file mode.
- Repository tests verify parameterized relational filters, bounded page sizes, stable sort allowlisting, and row mapping with a mocked PostgreSQL client.
- PostgreSQL-specific execution plans, migration execution, and live query performance require a configured PostgreSQL service and are not claimed as verified in this environment.


## Phase 21 — Normalized Ticket Write Path
- Ticket GET/POST/PATCH/DELETE can use direct normalized PostgreSQL when `PERSISTENCE_MODE=normalized`.
- Ticket create/update/delete are transactional and parameterized.
- Ticket delete cleans relational comments and attachments metadata.
- Audit events are written to the normalized audit table.
- JSONB compatibility remains available as fallback when normalized persistence is disabled.
- Live events continue to notify connected workspace clients.

The normalized write path should be exercised against a real PostgreSQL instance before production rollout.

## Phase 22 — Normalized Identity & Workspace Runtime

- Added relational runtime repositories for users, workspaces, and workspace memberships.
- Normalized mode now reads authenticated users, workspace lists, and member lists from PostgreSQL relational tables.
- Added `workspace_memberships.joined_at` plus supporting indexes in migration `008_identity_runtime.sql`.
- Existing JSON aggregate remains a compatibility projection while the remaining runtime domains are migrated.
- The repository boundary keeps SQL parameterized and avoids exposing password hashes through API responses.


# Phase 23 — Normalized Identity & Workspace Write Paths

## Added in Phase 23

- Registration creates the user, default workspace, and owner membership directly in PostgreSQL within one transaction when `PERSISTENCE_MODE=normalized` is enabled.
- Login resolves credentials from the relational `users` table; authentication continues to resolve the current account from PostgreSQL.
- Profile display-name updates and password-reset changes write directly to `users` and are mirrored to the legacy aggregate only for compatibility with routes not yet migrated. Password-reset tokens are now stored and consumed in `password_reset_tokens` with a row lock; issuing a new reset invalidates previous reset tokens for that account.
- Workspace creation writes the workspace and owner membership atomically to PostgreSQL.
- Workspace member list/add/change-role/remove operations use relational repositories. Owner memberships cannot be changed or removed, and users cannot change their own role.
- Invitation acceptance inserts the membership in PostgreSQL and writes its audit record in the same transaction.
- Membership and workspace audit events are committed with the corresponding relational write.
- Added migration `009_identity_write_indexes.sql` for workspace membership and workspace-name access patterns.
- The compatibility aggregate is no longer projected over normalized tables on every write when `PERSISTENCE_MODE=normalized`; doing so would erase newer direct relational writes. Legacy aggregate routes remain in compatibility mode until their domains are migrated.
- Migration backfill now skips existing relational identity data, preventing repeated `npm run db:migrate` runs from overwriting newer normalized records with stale aggregate state.

## Phase 23 validation and boundaries

- Repository unit tests use a mocked PostgreSQL client to verify parameterized statements, transactional account creation inputs, owner-role protections, and membership mutations.
- Existing API integration tests continue to run in JSON-file compatibility mode.
- A live PostgreSQL service was not available here, so actual migration execution, concurrent registration races, and database-level integration remain deployment verification tasks.
- At the end of Phase 23, refresh-token rotation and invitation creation still used the JSONB compatibility aggregate. Phase 24 moves those two domains to relational runtime repositories; notifications, comments, attachments, and presence remain to be migrated.

## Enable Phase 23 normalized identity/workspace writes

1. Configure `DATABASE_URL` and install the PostgreSQL driver (`npm install pg`).
2. Run `npm run db:migrate`; migration `009_identity_write_indexes.sql` is applied after the previous schema migrations.
3. The migration runner performs the compatibility backfill only when the relational `users` table is empty. Re-running migrations will not rebuild populated relational tables from stale JSONB state.
4. Set `PERSISTENCE_MODE=normalized` and restart the API.
5. Verify registration/login, profile update, workspace creation, member list/add/change-role/remove, invitation acceptance, password reset, and the audit timeline against the target PostgreSQL database.

Do not switch an already-used normalized database back to legacy persistence mode without a deliberate export/reconciliation plan. The compatibility aggregate is a bridge for unmigrated domains, not the source of truth for normalized identity, workspace, membership, ticket, or password-reset records.

# Phase 24 — Relational Sessions & Workspace Invitations

## Added in Phase 24

- Normalized registration now creates the account, default workspace, owner membership, and first refresh-token record in one PostgreSQL transaction. The JSON aggregate keeps only the compatibility identity projection; refresh-token secrets and hashes are not copied into it.
- Normalized login stores refresh-token hashes in `auth_refresh_tokens` rather than the JSONB aggregate.
- Refresh-token rotation locks the presented token row with `SELECT ... FOR UPDATE`, revokes the previous token, and persists its replacement in the same transaction. Reuse of a revoked or expired token revokes the whole token family.
- Logout revokes the token family in PostgreSQL. Password reset consumes the reset token, updates the password, and revokes active refresh tokens in the same transaction.
- Invitation creation and acceptance use `workspace_invitations` in normalized mode. Invitation acceptance validates the authenticated user's email and expiry, inserts membership, marks the invitation accepted, and writes the audit event atomically.
- Replacing an outstanding invitation revokes the prior pending record; it does not mark it as accepted.
- Added migration `010_session_invitation_runtime.sql` for family, active-session, and pending-invitation indexes.
- JSON-file persistence remains supported when normalized mode is disabled.

## Phase 24 validation and boundaries

- Backend/API and repository tests: 21 passing.
- New repository tests cover hashed refresh-token persistence, row-locked rotation, token-family revocation, invitation replacement, email/expiry validation, and transactional membership/audit writes.
- Existing JSON-file API integration tests continue to pass.
- PostgreSQL live integration, migration execution against a real database, and concurrency testing require a configured PostgreSQL instance and are not claimed as verified here.
- Notifications, comments, attachments, and presence still require their own normalized runtime cut-over; the compatibility aggregate is not yet removable.

## Enable Phase 24 normalized sessions and invitations

1. Configure `DATABASE_URL` and install the PostgreSQL driver.
2. Run `npm run db:migrate` to apply `010_session_invitation_runtime.sql` after the earlier migrations.
3. Keep `PERSISTENCE_MODE=normalized` enabled consistently for all API instances sharing the database.
4. Verify registration, login, refresh rotation/replay, logout, password reset, invitation creation, and invitation acceptance against PostgreSQL before production rollout.


## Phase 25 changes — normalized collaboration runtime

When `PERSISTENCE_MODE=normalized` is enabled, collaboration endpoints now use PostgreSQL relational tables directly rather than reading or writing the JSONB compatibility aggregate:

- Ticket comments are listed, created, and deleted from `ticket_comments`; comment author data is joined from `users`. Comment creation, recipient notifications, and audit records are written in one database transaction.
- Workspace notifications are listed and marked read from `workspace_notifications`, scoped to the authenticated recipient and workspace. Ticket create/update notifications are inserted in the same transaction as their ticket and audit writes.
- Presence heartbeats use an upsert into `workspace_presence`; online members are selected with a 60-second activity window.
- Attachment metadata is listed, created, and deleted in `ticket_attachments`; private file bytes remain in `UPLOAD_DIR`. Metadata and audit writes are transactional, and uploaded bytes are removed if metadata persistence fails. Ticket deletion also cleans up the corresponding disk files.
- Workspace events and ticket query/list permission checks now resolve membership from the relational membership table in normalized mode.
- Added migration `011_collaboration_runtime_indexes.sql` for comment mentions, unread notifications, attachments, and audit queries.

The JSON-file/legacy persistence path remains available for compatibility. Existing JSONB records are not automatically copied on each request; operators must run the migration/backfill workflow before enabling normalized mode on an existing installation.

### Phase 25 verification

- `node --test server/tests/*.test.mjs`: 27 tests passed.
- JavaScript syntax checks: passed for the server and normalized repository.
- PostgreSQL repository behavior is covered with query-level mocks; a live PostgreSQL deployment/migration was not available in this environment.
- Frontend code was unchanged in this phase; no Vite build was required.


# Phase 26 — Normalized Idempotent Ticket Imports & Database Verification

## Added in Phase 26

- Ticket import now has a normalized runtime branch when `PERSISTENCE_MODE=normalized` is enabled. Workspace authorization is resolved from `workspace_memberships`; it does not read the JSONB aggregate.
- Dry-run checks the normalized `ticket_import_batches` table and reports whether the workspace/batch key has already been committed.
- Commit inserts the idempotency batch, all ticket rows, and the audit record in one PostgreSQL transaction. A conflict on `(workspace_id, batch_key)` returns the existing batch as a duplicate without inserting tickets again.
- Ticket import publishes `ticket.created` live events after a successful commit. The legacy JSON-file/JSONB compatibility branch remains supported when normalized persistence is disabled.
- Added migration `012_import_runtime_indexes.sql` for import history queries.
- Added `npm run db:verify` (`server/verify-normalized.mjs`) to inspect required normalized tables, applied migration count, relational row counts, constraint coverage, and selected orphan checks. It deliberately does not require parity with the JSONB aggregate because migrated relational domains are authoritative and the aggregate can be stale.

## Phase 26 validation and boundaries

- `npm run test:api`: 31 tests passed, including three new repository tests for normalized import commit, idempotency conflict handling, and workspace-scoped batch lookup.
- `node --check` passed for the API, normalized repository, and database verifier.
- Migration and OpenAPI YAML files were parsed successfully; ZIP integrity was checked.
- Tests for normalized import use a mocked PostgreSQL client. A live PostgreSQL service was not available, so actual migration execution, concurrent import requests, and `db:verify` against a real database are not claimed as verified.
- `ashkan_app_state` has not been deleted. The remaining legacy compatibility endpoints and migration/backfill strategy must be audited before removing it safely.

## Verify a normalized PostgreSQL database

1. Install the PostgreSQL driver (`npm install pg`) and configure `DATABASE_URL` (plus `PG_SSL=true` when required).
2. Apply pending migrations with `npm run db:migrate`.
3. Run `npm run db:verify` to inspect required tables, row counts, constraints, and selected referential-integrity checks.
4. Keep `PERSISTENCE_MODE=normalized` consistent across all API instances. Do not delete `ashkan_app_state` until the remaining compatibility routes and any required historical data have been explicitly reconciled.

# Phase 27 — Backup, Restore & Workspace Export

## Workspace export

Authenticated workspace members with `read` permission can download a portable JSON snapshot:

```http
GET /api/workspaces/{workspaceId}/export
Authorization: Bearer <access-token>
```

The export is workspace-scoped and uses a repeatable-read, read-only PostgreSQL transaction in normalized mode. It includes workspace metadata, member identities/roles, tickets, comments, notifications, audit events, import batch metadata, and attachment metadata. It deliberately excludes password hashes, refresh/password-reset tokens, invitation token hashes, attachment storage names/file bytes, and online presence. This is an export, not a lossless backup; uploaded file bytes are covered by the operational backup below.

## PostgreSQL backup

Requirements: PostgreSQL client tools (`pg_dump` and `pg_restore`) must be installed and available on PATH. Set `DATABASE_URL`, and optionally `PG_SSL=true`, `BACKUP_DIR`, `UPLOAD_DIR`, `PG_DUMP_BIN`, and `PG_RESTORE_BIN`.

```bash
npm run db:backup
```

The command creates a timestamped directory containing a custom-format PostgreSQL dump, a copy of the configured private uploads directory (when present), and a SHA-256 manifest. It validates the dump's table-of-contents with `pg_restore --list`. Backups contain sensitive data; keep the backup directory encrypted and access-restricted. The application does not automatically upload or retain backups remotely.

## Restore (destructive)

Restore requires an explicit backup path, a separate target database URL, and an acknowledgement:

```bash
BACKUP_PATH=./backups/ashkan-... \
RESTORE_DATABASE_URL='postgresql://restore-target' \
RESTORE_CONFIRM=YES \
npm run db:restore
```

The restore command verifies every file checksum and inspects the dump before running `pg_restore --clean --if-exists`. It does not infer the target from `DATABASE_URL`. Uploaded files are restored only when `RESTORE_UPLOAD_DIR` is explicitly supplied; the target directory must not exist. Always restore into an isolated database first, validate application data and file references, and only then switch production traffic. A restore can overwrite/drop objects in the selected target database.

## Phase 27 validation

Unit tests cover manifest creation/verification, tamper detection, and safe workspace export fields. PostgreSQL client binaries and a live database are not available in this build environment, so a real dump/restore cycle was not performed. The restore workflow must be rehearsed against a disposable PostgreSQL instance before production use.

# Phase 28 — Normalized Cut-over Guard & Legacy Store Audit

## Added in Phase 28

- Removed compatibility JSONB mirror writes from normalized registration, profile updates, workspace creation, invitation acceptance, membership changes, and password-reset completion. These operations now rely only on their normalized PostgreSQL transactions.
- The legacy aggregate adapter now fails closed: `readStore()` and `updateStore()` throw explicit errors whenever both `DATABASE_URL` and `PERSISTENCE_MODE=normalized` are set. This prevents a route regression from silently reading stale JSONB state or writing a second, divergent copy.
- Health/readiness metadata reports `postgres-normalized-runtime+legacy-jsonb-locked` when normalized mode is selected.
- Added `npm run db:cutover-audit` to inspect required relational tables, applied migrations, and the remaining `ashkan_app_state` table/row count. The audit intentionally reports `review-required` rather than claiming the aggregate is safe to drop.
- Added tests proving that legacy aggregate reads and writes are rejected in normalized mode.

## Phase 28 architecture boundary

This phase retires the JSONB aggregate from the normalized runtime path; it does **not** drop the `ashkan_app_state` table or delete historical data. The table remains available to the one-time migration/backfill workflow and to installations still running the legacy persistence mode. Some request handlers retain legacy-mode branches for backwards compatibility. In normalized mode, supported migrated operations must use relational repositories; unsupported methods fail closed if they accidentally reach the legacy adapter.

## Cut-over audit

After applying migrations and setting `PERSISTENCE_MODE=normalized`, run:

```bash
npm run db:verify
npm run db:cutover-audit
```

The cut-over audit requires `DATABASE_URL` and normalized mode. It lists the remaining aggregate row count but never drops the table. Do not remove `ashkan_app_state` until historical JSONB-only fields, import history, attachment bytes, and any deployment-specific data have been reconciled and a verified backup/restore has been rehearsed.

## Phase 28 validation

- `node --check` passed for the modified server modules and new audit script.
- `node --test server/tests/*.test.mjs` covers the existing API/repository/backup suite plus the normalized-mode read/write guards.
- No live PostgreSQL service was available, so `db:verify`, `db:cutover-audit`, migration execution, and live database transactions were not run against a real database.
- Frontend source was not changed; Vite build and ESLint were not rerun in this phase.

# Phase 29 — Legacy JSONB Reconciliation

Phase 29 adds a read-only reconciliation utility before any retirement of the legacy aggregate is considered.

## Run the reconciliation

Configure `DATABASE_URL`, ensure the PostgreSQL driver is installed (`npm install pg`), and run:

```bash
npm run db:reconcile-legacy
```

For a strict check that exits with status `2` when the aggregate snapshot is missing or any key/count difference is found:

```bash
npm run db:reconcile-legacy -- --strict
```

The utility opens a `REPEATABLE READ READ ONLY` transaction, reads the legacy `ashkan_app_state` snapshot (when present), and compares record counts and identity keys for Users, Workspaces, Memberships, Tickets, Refresh Tokens, Password Resets, Invitations, Audit Logs, Notifications, Comments, Attachments, Presence, and Import Batches. Composite keys are used for Memberships and Presence. It prints a JSON report with mismatch counts and up to ten sample keys per direction.

**Safety:** this command is strictly read-only. It never backfills, updates, deletes, or drops data. It is a reconciliation report, not a migration or a complete field-by-field checksum. It does not verify attachment bytes, and Presence differences can be expected because Presence is ephemeral. Matching identity keys do not prove that every business field is identical. Review all differences and separately verify file storage before any destructive cut-over.

The old `ashkan_app_state` table is intentionally retained. Do not drop it based only on a successful key-parity report; first take and rehearse a verified backup/restore and approve retirement explicitly.


# Phase 30 — Data Integrity & Attachment Fingerprints

Phase 30 adds a read-only integrity inspection that compares normalized relational records with the retained legacy snapshot at field level, checks important referential relationships, and verifies private attachment files against their database metadata.

## Run the integrity inspection

Configure `DATABASE_URL`, `UPLOAD_DIR`, and install the PostgreSQL driver, then run:

```bash
npm run db:integrity
```

For CI/cut-over gating, use `npm run db:integrity -- --strict`. The command runs inside a `REPEATABLE READ READ ONLY` transaction and reports field names that differ without printing the underlying values (including credential hashes and invitation/refresh token hashes). It checks missing/extra records, duplicate identities, selected foreign-key relationships, unvalidated foreign-key constraints, attachment path safety, missing files, file sizes, and SHA-256 values when a stored checksum exists. Presence timestamps are intentionally treated as volatile; identity parity is still checked.

## Attachment checksum backfill

New attachment uploads store a SHA-256 content fingerprint in PostgreSQL and the legacy-mode record. Existing attachments may have a null checksum. First inspect the proposed backfill (read-only):

```bash
npm run db:attachment-checksums
```

Only after reviewing missing files, size mismatches, and unsafe paths should an operator explicitly apply the checksum updates:

```bash
npm run db:attachment-checksums -- --apply
```

The apply operation is all-or-nothing: if any referenced file is missing, has a size mismatch, or uses an unsafe storage name, no checksum rows are updated. It does not modify file bytes. Migration `013_attachment_content_checksums.sql` adds the nullable SHA-256 column; old records must be backfilled before a strict integrity report can pass.

## Phase 30 boundaries

- The integrity and checksum inspection commands do not delete or repair domain records.
- `ashkan_app_state` is not dropped in this phase. A matching report is a point-in-time comparison, not proof that every application route has been migrated or that no future divergence can occur.
- The report is only as complete as the retained legacy snapshot and the file directory supplied by `UPLOAD_DIR`.
- A live PostgreSQL run and a real backup/restore rehearsal are still required before a production cut-over.

## Phase 31 — Runtime Cutover Audit

Phase 31 adds an automated runtime cutover audit for the retained JSONB compatibility adapter. The audit records the normalized persistence guards, enumerates remaining legacy adapter call sites for operator review, and verifies that the store layer fails closed when normalized persistence is enabled.

Run:

```bash
npm run db:runtime-cutover-audit
```

The audit is intentionally conservative: it does not delete `ashkan_app_state`, does not mutate data, and does not claim that PostgreSQL has been live-tested when a database is unavailable. Legacy call sites remain available for installations that explicitly run the legacy persistence mode.


## Phase 32 — Legacy JSONB Adapter Isolation

Phase 32 isolates the remaining legacy JSONB compatibility path from the application route layer. `server/app.mjs` no longer calls `readStore()` or `updateStore()` directly; all compatibility-mode aggregate access is routed through `server/legacy-persistence.mjs`. The adapter fails closed whenever `DATABASE_URL` and `PERSISTENCE_MODE=normalized` are active.

### Cutover verification

Run:

```bash
npm run db:final-cutover-check
npm run test:api
```

The final cutover check requires zero direct legacy aggregate calls in `server/app.mjs`, confirms normalized-mode guards, and verifies the dedicated compatibility adapter. Phase 32 does not delete `ashkan_app_state` or perform a live PostgreSQL migration; the legacy adapter remains available for explicit non-normalized compatibility mode.

## Phase 33 — Final PostgreSQL Normalized Cutover

Phase 33 prepares the final retirement of the legacy `ashkan_app_state` JSONB aggregate. The application layer already has zero direct `readStore()` / `updateStore()` calls; this phase adds migration `014_retire_legacy_aggregate.sql`, makes the migration runner tolerate an already-retired aggregate, and adds `npm run db:final-cutover-check` for source-level and optional live-database readiness checks.

The retirement migration is intentionally explicit: it drops the legacy indexes and `ashkan_app_state` table. Run the normal migration flow only after the normalized relational data has been reconciled and the operator has approved final cutover. A live PostgreSQL cutover is not claimed unless `DATABASE_URL` is available and the check reports the aggregate as absent.

## Phase 34 — PostgreSQL Production Hardening & Zero-Downtime Cutover Readiness

Phase 34 hardens the normalized PostgreSQL runtime for production deployment:

- Centralized PostgreSQL pool configuration with bounded connection/query/idle timeouts, keepalive, application name, and configurable pool sizing.
- Graceful PostgreSQL pool shutdown during API termination.
- Migration execution is serialized with a session-level advisory lock held on a dedicated PostgreSQL client.
- Migration lock/statement timeouts fail safely instead of waiting indefinitely on DDL contention.
- Production readiness now validates normalized persistence, required relational tables, the final retirement migration, and absence of `ashkan_app_state`.
- Added `/api/health/live` for process liveness while `/api/health/ready` remains dependency/schema readiness.
- PostgreSQL backup/restore now pass database connection URLs explicitly with `--dbname`, avoiding misuse of `PGDATABASE` for full connection strings.
- Production environment examples expose PostgreSQL pool and timeout controls.

Validation:

- API test suite: 61/61 passing.
- Node syntax checks passed for changed server/ops modules.
- PostgreSQL live migration/restore was not executed because no live PostgreSQL service is available in this validation environment.
- Frontend build/lint was not executed because frontend dependencies are not installed in this environment.

## Phase 35 — Production Observability & Runtime Hardening

Phase 35 adds a dependency-free Prometheus text exposition endpoint and hardens the HTTP runtime:

- `GET /api/metrics` is disabled by default. Enable it with `METRICS_ENABLED=true` and protect it with a unique `METRICS_TOKEN` (at least 32 characters). Requests must send `Authorization: Bearer <token>`.
- Metrics include completed request counters by method/status class, bounded-cardinality request-duration histograms, in-flight requests, process uptime, and resident memory. URLs, workspace IDs, user IDs, and query strings are never metric labels.
- Structured request logs include request ID, method, path without query string, status, and duration. Unexpected failures emit a separate structured event with safe error metadata and return the request ID to the client.
- The in-memory rate limiter now has configurable limits and a hard cap on tracked client keys. It intentionally uses the direct TCP peer address; do not trust forwarded IP headers unless a trusted reverse proxy is configured at the network edge.
- Production responses add HSTS and additional browser security headers. HSTS assumes the service is exposed only through HTTPS at the reverse proxy.
- Graceful shutdown closes the HTTP listener and PostgreSQL pool, is idempotent across repeated signals, and has a configurable hard deadline. This phase also fixes the missing PostgreSQL pool-close import in the previous shutdown path.
- Docker Compose runs the API with a read-only root filesystem, a writable upload volume, dropped Linux capabilities, `no-new-privileges`, bounded JSON-file logs, and a loopback-only published port for a TLS reverse proxy.

### Operations

```bash
# Enable metrics only when a strong token is configured
METRICS_ENABLED=true
METRICS_TOKEN=<at-least-32-character-random-secret>

# Scrape from a trusted monitoring system
curl -H "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:4000/api/metrics
```

Rate limiting is process-local and therefore not a distributed quota across multiple API replicas. For multi-replica deployments, enforce a shared edge/API-gateway limit (or introduce a shared Redis-backed limiter) and restrict the metrics route at the network layer as well as with its token. Do not expose port 4000 directly to the public internet; terminate TLS at a reverse proxy.

### Phase 35 validation boundaries

- Unit and API tests cover rate-limit bounds, metrics cardinality and authentication, request IDs, and security headers.
- Live PostgreSQL, Docker daemon, TLS reverse-proxy, and external monitoring integration tests must still be run in the deployment environment.

# Phase 36 — CI/CD Automation & Deployment Pipeline

## Automated verification

GitHub Actions workflow `.github/workflows/ci.yml` runs on pushes to `main`/`master`, pull requests, and manual dispatch. It installs the exact lockfile dependencies with `npm ci`, runs ESLint, builds the Vite frontend, runs the backend test suite, checks server module syntax, and builds the production Docker image. The PostgreSQL migration and live database checks remain environment-dependent and are not represented as passing in CI without a configured database service.

## Container publishing

`.github/workflows/container-release.yml` publishes the production API image to GitHub Container Registry (GHCR) after a push to the default branch or a version tag such as `v1.2.3`. Images receive branch/tag/SHA labels and BuildKit provenance and SBOM attestations. The package visibility and registry pull permissions must be configured according to the target server's policy.

## Manual deployment

`.github/workflows/deploy.yml` is intentionally manual and requires a GitHub Environment approval policy if desired. Configure these environment/repository secrets:

- `DEPLOY_HOST`: deployment server hostname.
- `DEPLOY_USER`: SSH user with permission to run Docker Compose.
- `DEPLOY_SSH_KEY`: private SSH key for that user.
- `DEPLOY_KNOWN_HOSTS`: pre-verified SSH host-key line(s); do not populate this with unverified `ssh-keyscan` output during a deployment.
- `DEPLOY_PATH`: absolute server directory containing `docker-compose.yml` and the production `.env` file.

The target server must have Docker Compose installed and be able to pull the selected GHCR image. For a private GHCR package, authenticate Docker on the target host before deployment using a narrowly scoped read-only package token. The server's `.env` must already contain all production secrets and configuration; CI does not transmit or generate production secrets.

The deployment workflow validates the requested tag, pulls the image, recreates only the API service without rebuilding on the server, and polls `/api/health/ready`. It prints recent API logs and fails if readiness is not achieved. This workflow does not claim zero-downtime deployment or automatic rollback; use a load balancer/redundant API instances and a rehearsed rollback procedure before treating it as zero-downtime.

## Compose image selection

`ASHKAN_IMAGE` selects the API image. Local deployments retain the `ashkan-board:local` default and can build from the checked-out source. CI deployment sets `ASHKAN_IMAGE` to the immutable/released GHCR tag and uses `docker compose up --no-build`.

## Phase 36 validation

The CI workflow is committed as source configuration. Local validation in this environment covers backend tests, JavaScript syntax, workflow YAML parsing, Docker Compose configuration structure where available, and ZIP integrity. Actual GitHub Actions execution, GHCR publishing, SSH deployment, Docker daemon execution, and production PostgreSQL connectivity require the user's GitHub repository and deployment infrastructure and are not claimed as executed here.

## Phase 37 — Automated Quality Assurance & End-to-End Testing

Phase 37 adds browser-level quality gates for the primary workspace journeys.

### Browser test coverage

- New account registration and workspace bootstrap
- Invalid sign-in feedback and Persian/English locale switching
- Ticket creation, search, update, deletion, and persisted state after reload
- Priority filtering
- Profile update and logout
- Mobile viewport rendering and navigation drawer interaction

### Run locally

Install the normal project dependencies, then install the pinned browser test runner and Chromium:

```bash
npm ci
npm install --no-save --package-lock=false @playwright/test@1.56.1
npx playwright install chromium
npm run test:e2e
```

The Playwright configuration starts an isolated JSON-file-backed API process and the Vite development server. It uses a dedicated test data file under `/tmp`; it does not connect to a production database. Browser traces, screenshots, and videos are retained for failed tests in `test-results/`.

### CI quality gate

The GitHub Actions CI workflow runs the browser suite after the existing lint, frontend build, backend tests, and server syntax checks. The production container build waits for both verification and browser E2E jobs. Container release also runs the browser suite before publishing an image. The Playwright HTML report and failure artifacts are uploaded as a workflow artifact.

The browser runner is installed at a pinned version in CI without changing the application's production dependencies or lockfile. This keeps Playwright out of the production image. A successful local source/package validation is not a substitute for executing Chromium; the actual browser run occurs in GitHub Actions where the browser binary and system libraries can be installed.


## Phase 38 — Performance Engineering & Scalability

Phase 38 adds production-oriented query indexes, a read-only PostgreSQL performance audit, a credentialed HTTP load-smoke runner, and lazy loading for the ticket editor.

### PostgreSQL query performance

Migration `015_performance_indexes.sql` adds workspace/status and workspace/priority sort indexes, plus `pg_trgm` GIN indexes for the existing substring `ILIKE` ticket search and a partial unread-notification index. Apply migrations with `npm run db:migrate`. The database role must be allowed to install the `pg_trgm` extension; if your managed PostgreSQL provider restricts extension creation, enable `pg_trgm` through its database console or administrator before applying migration 015.

After applying the migration and loading representative data, run `ANALYZE tickets; ANALYZE workspace_notifications;` and inspect estimated plans with:

```bash
DATABASE_URL=... npm run db:performance-audit
```

The audit reports missing expected indexes, table scan counters, and `EXPLAIN (FORMAT JSON)` plans. It is read-only and deliberately does not run `EXPLAIN ANALYZE`; query plans and statistics must be reviewed on a production-like dataset.

### HTTP load smoke test

The dependency-free load runner exercises the authenticated, paginated ticket-query endpoint. Run it against a test or staging environment only:

```bash
PERF_BASE_URL=https://staging.example.com \
PERF_TOKEN='short-lived-test-access-token' \
PERF_WORKSPACE_ID='workspace-uuid' \
PERF_REQUESTS=200 PERF_CONCURRENCY=10 PERF_WARMUP=5 \
npm run perf:smoke
```

Optional `PERF_P95_LIMIT_MS` makes the run fail when the observed p95 latency exceeds the configured threshold. Defaults are bounded (100 measured requests, concurrency 10); maximums are 10,000 requests and 100 concurrent workers. Never point this smoke test at production without an approved traffic window and explicit rate/impact limits. Results are a baseline, not a universal capacity guarantee.

### Frontend delivery

The ticket editor is loaded with `React.lazy` and `Suspense`, so its code is split from the initial board bundle and downloaded when a ticket dialog is first opened.

### Phase 38 validation

Backend unit/API tests cover the new migration contract, audit summarization, load-runner configuration and lazy-loaded editor wiring. No live PostgreSQL plan, pg_trgm installation, real load test, or browser bundle measurement is claimed unless run against the target infrastructure.

## Phase 39 — Caching Architecture & Advanced Scalability

Phase 39 adds a bounded ticket-query cache with optional Redis backing and a process-local fallback. The normalized PostgreSQL ticket list and filtered-query endpoints use cache keys scoped by workspace, query options, and a workspace generation counter. Ticket create/update/delete and successful ticket imports advance that generation so old query entries are no longer selected.

### Cache configuration

- `REDIS_URL`: optional `redis://` or `rediss://` URL. When configured, Redis is used for shared cache entries and generation counters across API instances.
- `REDIS_TIMEOUT_MS`: per-command connection/response deadline (default `1500`).
- `TICKET_CACHE_TTL_SECONDS`: bounded ticket-query TTL (default `10`, maximum `300`).
- `CACHE_MEMORY_MAX_ENTRIES`: process-local fallback capacity (default `1000`).

If Redis is unavailable, the API continues using a bounded in-memory cache. Cache failures do not make PostgreSQL reads fail; the database remains authoritative. During a Redis outage, invalidation on other instances cannot be coordinated, so stale cache data may remain until the short TTL expires. For production, configure Redis and keep the ticket TTL conservative.

The production Compose stack now includes a private Redis 7 service with password authentication, AOF persistence, a health check, and no host-published port. Set `REDIS_PASSWORD` to a long URL-safe secret, or supply a correctly URL-encoded `REDIS_URL` explicitly. The API waits for Redis health before Compose starts it, but still degrades safely if Redis later becomes unavailable.

Run cache unit tests with `npm run cache:check`; run the complete backend suite with `npm run test:api`. The cache is applied to normalized PostgreSQL ticket list/query reads; legacy compatibility reads remain uncached.

## Phase 40 — Distributed Cache Reliability & Observability

Phase 40 adds operational safeguards around the optional Redis-backed ticket cache:

- Per-process cache telemetry: Redis hits, memory hits, misses, loader executions/errors, coalesced requests, Redis commands/errors, circuit opens, and invalidations.
- A Redis circuit breaker with a bounded failure threshold and cooldown. While open, cache calls skip Redis and continue through the bounded local cache/database loader path; a later request probes Redis after the cooldown.
- Single-flight request coalescing so concurrent misses for the same workspace/query key share one loader promise per API process.
- Prometheus cache counters and gauges are appended to the existing authenticated `/api/metrics` endpoint. The `/api/health` response also exposes the cache diagnostics snapshot.

### Reliability configuration

- `REDIS_CIRCUIT_FAILURE_THRESHOLD`: consecutive Redis command failures before opening the circuit (default `3`, bounded to `1..20`).
- `REDIS_CIRCUIT_COOLDOWN_MS`: time before a single request may probe Redis again (default `15000`, bounded to `1000..120000`).

The circuit breaker and single-flight map are process-local. Redis still provides shared cache values and workspace generations when healthy. During Redis outages, each API instance independently falls back; cross-instance invalidation cannot be guaranteed until Redis recovers, so the configured short ticket TTL remains an important stale-data bound. PostgreSQL remains authoritative. Run `npm run cache:diagnostics` for cache and observability unit tests.

## Phase 41 — Enterprise Security & Advanced Access Controls

Phase 41 adds production-oriented account security capabilities: encrypted TOTP secrets, optional two-factor authentication with short-lived MFA challenges, security-event auditing, session visibility and global session revocation. The normalized PostgreSQL migration is `016_enterprise_security_hardening.sql`.

Security endpoints:
- `POST /api/auth/2fa/setup`
- `POST /api/auth/2fa/verify`
- `DELETE /api/auth/2fa`
- `GET /api/auth/security`
- `GET /api/auth/sessions`
- `POST /api/auth/sessions/revoke-all`

TOTP secrets are encrypted at rest using a key derived from `JWT_SECRET`. Real PostgreSQL migration execution, authenticator-app interoperability, OAuth/OIDC provider integration, and production SSO deployment still require environment-level validation.

## Phase 42 — Enterprise OIDC / SSO

AshkanBoard now includes an optional OpenID Connect authorization-code flow with PKCE. Configure `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and `OIDC_REDIRECT_URI` to enable the Enterprise SSO button. OIDC identities are linked to normalized PostgreSQL users through `oidc_identities`; first-time identities receive a workspace and subsequent logins reuse the linked account. Optional `OIDC_ALLOWED_DOMAINS` restricts sign-in to approved email domains.

The callback returns short-lived session tokens in the URL fragment so browsers do not send them as HTTP query parameters. For production, configure the provider redirect URI exactly and terminate TLS at the reverse proxy.

## Phase 43 — Enterprise Provisioning & SCIM 2.0

Phase 43 adds a normalized PostgreSQL SCIM 2.0 provisioning surface under `/scim/v2` for Users and Groups. The endpoint is bearer-token protected by `SCIM_BEARER_TOKEN` (minimum 32 characters) and is enabled only when normalized PostgreSQL persistence is active. User provisioning is idempotent by `externalId`, supports PATCH activation/display-name changes, and deprovisioning removes workspace memberships. SCIM groups map to AshkanBoard workspaces and maintain group membership mappings. The migration is `018_scim_provisioning.sql`.

The Phase 42 blank-screen regression was also fixed: `AuthGate` now owns the `mfaChallenge` and `otp` state used by the MFA login flow. This prevents the browser from throwing a `ReferenceError` during initial React rendering.

## Phase 44 — Local Development Connectivity Hardening

The development workflow now starts the API and Vite together with `npm run dev`.
Vite proxies `/api` and `/scim` to `http://localhost:4000`, while the frontend falls back to the current browser origin when `VITE_API_URL` is not configured. This avoids accidental browser-to-API origin mismatches and gives a clear error when the API process is unavailable.

For an explicit split workflow, use `npm run api` and `npm run dev:client` separately.

## Phase 45 — Runtime Connectivity & Registration Diagnostics

Phase 45 hardens local development connectivity between Vite and the API and makes registration failures diagnosable instead of exposing an opaque `API request failed (502)` message.

- `npm run dev` starts the API first and waits for `/api/health/live` before starting Vite.
- The frontend gives a specific message when a development proxy returns HTTP 502.
- Normalized registration returns a safe `503 PERSISTENCE_UNAVAILABLE` response when PostgreSQL/its driver is unavailable, with a request ID for server-side correlation.
- No production fallback from normalized PostgreSQL to the legacy JSON/file store was introduced.

If normalized persistence is enabled, PostgreSQL and the PostgreSQL Node driver must be available before registration can succeed.


## Phase 46 — Local API Proxy Reliability

Phase 46 fixes a Windows/local-development connectivity edge case where Vite could resolve `localhost` differently from the Node API listener. The Vite proxy now targets the IPv4 loopback address `http://127.0.0.1:4000` for both `/api` and `/scim`. The development launcher also probes the same IPv4 address before starting Vite.

Recommended local startup:

```bash
npm run dev
```

The API must become healthy at `http://127.0.0.1:4000/api/health/live` before Vite starts. If the frontend is started separately with `npm run dev:client`, the API must already be running with `npm run api`.

If registration reaches the API but PostgreSQL is unavailable in normalized mode, the expected response is `503 PERSISTENCE_UNAVAILABLE`, not a proxy `502`.


## Phase 47 — Enterprise RBAC & Advanced Permissions

Added workspace-scoped custom roles and permission sets on normalized PostgreSQL persistence. System roles (`owner`, `admin`, `member`, `viewer`) are seeded per workspace, while custom roles can be created, updated, and deleted through protected role-management endpoints. Membership responses now expose effective permissions, and ticket/member/audit authorization in normalized runtime uses those permissions. Migration `019_advanced_rbac.sql` removes the fixed membership-role constraint, creates `workspace_roles`, seeds system roles, and upgrades production readiness to the Phase 47 schema.

Role endpoints: `GET/POST /api/workspaces/:workspaceId/roles`, `PATCH/DELETE /api/workspaces/:workspaceId/roles/:roleKey`. Custom role keys are workspace-scoped and cannot use reserved system role names.


## Phase 48 — RBAC Management UI

Added a server-backed Roles & Permissions administration experience to Organization Center. Administrators can review system and custom workspace roles, inspect effective permissions, create custom roles, edit their display name and permissions, delete unassigned custom roles, and assign any available workspace role from the member/invitation controls. Authorization remains enforced by the Phase 47 backend RBAC layer.


### Phase 48 Hotfix — Windows/Node 26 development startup

- `server/security.mjs` now keeps production strict while generating an ephemeral development JWT secret when `JWT_SECRET` is missing, with a clear warning.
- `scripts/dev.mjs` now launches npm through Node's npm CLI entrypoint on Windows when `npm_execpath` is available, avoiding `spawn EINVAL` observed with Node.js 26.
- For stable local sessions, set `JWT_SECRET` to a random value of at least 32 characters in `.env`.


## Phase 48 Hotfix 3
- Hardened Windows development process orchestration with absolute project paths and direct Node entrypoints.
- API child process now receives the selected PORT explicitly and reports its PID.
- Dev startup now detects API process exit during readiness polling instead of waiting silently.
- Windows shutdown uses `taskkill /T /F` for child process trees.
- API listen errors are surfaced explicitly, including port conflicts.
- Backend regression suite: 91/91 passed.

## Phase 49 — Identity Role Mapping

Added workspace-scoped identity role mappings for enterprise provisioning. Administrators can map OIDC claims or SCIM attributes to existing workspace roles with configurable priority and enable/disable state. The normalized runtime exposes CRUD endpoints under `/api/workspaces/:workspaceId/role-mappings`, validates target roles server-side, and applies matching OIDC claims during SSO login. Migration `020_identity_role_mappings.sql` adds the mapping store.

Supported mapping sources are `oidc` and `scim`. Example OIDC claims include `groups` and `roles`; a mapping can promote a matching identity into a custom workspace role without changing the role catalog itself.

## Phase 50 — Audit & Access Review
- Added server-side audit filtering for action, entity type, actor, and date range.
- Added bounded audit queries up to 500 records while preserving the legacy numeric limit API.
- Added Organization Center audit/access review filters and audit CSV export.
- Added Phase 50 regression coverage in `server/tests/audit-access-review.test.mjs`.
- Package version: `0.0.0-phase50`.

## Phase 51 — Session Security & Device Control
- Added session-family summaries so the account security panel shows logical sessions instead of individual rotated refresh-token rows.
- Added per-session revocation at `POST /api/auth/sessions/:familyId/revoke`, scoped to the authenticated user.
- Added session token-count and revoked-state information to the security API.
- Added per-session revoke controls to the Account Center while preserving revoke-all behavior.
- Revocation emits the `session.revoked` security event.
- Package version: `0.0.0-phase51`.


## Phase 52 — Notification Preferences & Delivery Controls
- Added workspace-scoped notification preferences for the authenticated member.
- Added controls for all notifications, mentions, ticket updates, comments, and system notifications.
- Added `GET/PATCH /api/workspaces/:workspaceId/notification-preferences`.
- Normalized notification creation now respects the recipient's preferences without changing read-state semantics.
- Added migration `021_notification_preferences.sql` and regression coverage.
- Package version: `0.0.0-phase52`.


## Phase 53 — Workspace Webhooks & Integration Controls
- Added workspace-scoped outbound webhook subscriptions for ticket, comment, membership, and notification events.
- Added protected webhook CRUD under `/api/workspaces/:workspaceId/webhooks` plus a delivery test action.
- Secrets are stored as hashes; newly created webhooks return the secret once. Production requires HTTPS endpoints.
- Added delivery status, last-delivered timestamp, and failure counters.
- Added migration `022_workspace_webhooks.sql` and upgraded production readiness to the Phase 53 schema.
- Package version: `0.0.0-phase53`.

## Phase 54 — Webhook Delivery History
- Added `023_webhook_delivery_history.sql` for durable webhook delivery attempts.
- Added delivery history retrieval and per-attempt status/error metadata.
- Test webhook deliveries now persist an audit trail in normalized PostgreSQL mode.
- Production readiness advances to migration 023.


## Phase 55 — Webhook Secret Rotation
- Added workspace webhook secret rotation with one-time secret display.
- Added versioned timestamped webhook signatures (`x-ashkan-signature-version: 1`, `x-ashkan-signature: t=...,v1=...`).
- Added migration `024_webhook_secret_rotation.sql`.
- Added Organization Center control for rotating webhook secrets.


## Phase 56 — Webhook delivery replay
- Added stored webhook delivery payloads for replayable deliveries.
- Added secure replay endpoint with timestamped signature and replay headers.
- Added `025_webhook_replay_payload.sql` migration.
- Added client API for delivery replay.


## Phase 57 — Webhook Delivery Observability
- Added server-side webhook delivery summary metrics (total, delivered, failed, status errors, success rate, last attempt).
- Added webhook history refresh controls and compact delivery history in Organization Center.
- Added replay action for failed deliveries from the webhook management panel.
- Added `webhookDeliverySummary` API client support.
- Version: `0.0.0-phase57`.


## Phase 58 — Webhook Retry Controls
- Configurable max attempts (1-10) and retry delay (0-86400 seconds).
- Delivery history records dead-letter state and next retry time.
- Replay is rejected once the configured retry limit is reached.
- Production readiness now requires migration 026_webhook_retry_controls.sql.


## Phase 59 — Automatic Webhook Retries
- Added a PostgreSQL-backed retry worker for due webhook deliveries.
- Added `retry_locked_at` claiming with `FOR UPDATE SKIP LOCKED` to prevent duplicate concurrent retries.
- Added configurable worker interval, batch size, and stale-lock recovery.
- Automatic retries emit `x-ashkan-retry: true` and reuse the current timestamped signature format.
- Retry attempts continue to honor Phase 58 max-attempt and dead-letter policy.
- Added migration `027_webhook_automatic_retries.sql`.
- Package version: `0.0.0-phase59`.

## Phase 60 — Webhook Circuit Breaker & Vite Parse Fix

- Fixed a Phase 59 frontend parse error in `src/App.jsx`: the webhook summary/history loading callback now correctly uses `async` before awaiting `Promise.all`.
- Added PostgreSQL webhook circuit-breaker controls in migration `028_webhook_circuit_breaker.sql`.
- Webhooks can automatically pause after the configured consecutive failure threshold.
- Added circuit policy API and Organization Center control to enable/disable the circuit breaker.
- Added `failureThreshold`, `circuitBreakerEnabled`, `circuitOpenedAt`, and `disabledReason` metadata.
- Production readiness now expects migration `028_webhook_circuit_breaker.sql`.


## Phase 64 — Webhook Delivery Retention
- Configurable per-webhook delivery history retention (1–3650 days).
- Scheduled PostgreSQL cleanup worker with bounded batch deletion and `FOR UPDATE SKIP LOCKED`.
- Environment controls: `WEBHOOK_RETENTION_WORKER_ENABLED`, `WEBHOOK_RETENTION_INTERVAL_MS`, `WEBHOOK_RETENTION_BATCH_SIZE`.
- Migration: `030_webhook_delivery_retention.sql`.


## Phase 67

- Fixed a Vite/OXC JSX parse error in `src/App.jsx` caused by an extra closing brace in the webhook history/dead-letter rendering block.
- Bumped package version to `0.0.0-phase67`.

## Phase 65 — Webhook Dead-Letter Queue Management

Phase 65 adds operational controls for webhook deliveries that have exhausted their retry policy. Administrators can inspect dead-letter deliveries, requeue a delivery for another retry attempt, or permanently discard a dead-letter record. The feature is workspace-scoped and uses the existing normalized PostgreSQL delivery history.

### New API actions
- `GET /api/workspaces/:workspaceId/webhooks/:webhookId?action=dead-letter`
- `POST /api/workspaces/:workspaceId/webhooks/:webhookId?action=requeue-dead-letter&deliveryId=...`
- `DELETE /api/workspaces/:workspaceId/webhooks/:webhookId?action=discard-dead-letter&deliveryId=...`

No new database migration is required for Phase 65; it builds on the dead-letter fields introduced in Phase 58 and the retention controls from Phase 64.


## Phase 67
Webhook retention operational controls add retention statistics, manual per-webhook purge, and a regression fix ensuring action-specific PATCH routes are evaluated before the generic webhook PATCH route.


## Phase 68 — Bulk Dead-Letter Recovery

Phase 68 adds a safe bulk Dead-Letter requeue operation for workspace webhooks. Operators with update permission can requeue up to 500 dead-lettered deliveries in one operation; rows are selected with `FOR UPDATE SKIP LOCKED` to avoid competing workers.


## Phase 70
- Webhook delivery retention dry-run preview endpoint.
- Reports expired delivery count and expired range without deleting records.
- API client support added.

## Phase 71

Adds a read-only webhook retention policy impact preview so operators can see how changing a webhook retention period would affect currently expired and newly-expired deliveries before applying the policy.

## Phase 74 — Ticket Creation Stability

This phase fixes the ticket-creation blank-screen path reported in the browser. The ticket editor is now imported directly instead of through a lazy dynamic import, removing a fragile runtime chunk-loading boundary when opening a new ticket. No new database migration is required.


## Phase 74 — Ticket Dialog Runtime & Windows Presence Stability

- Fixed a runtime `ReferenceError` when opening the ticket creation dialog: `MainDashboard` now owns and loads workspace members before passing them to `TaskDialog`.
- Restored lazy loading of `TaskDialog` with a visible Suspense fallback to keep the initial board bundle split.
- Added a frontend regression test for the `members` data flow.
- Hardened legacy JSON-file persistence on Windows: if atomic `rename()` is temporarily blocked with `EPERM`, `EACCES`, or `EBUSY`, the store falls back to a direct write so presence heartbeats do not return HTTP 500.
- No database migration is required.

## Phase 75 — Frontend crash recovery

- Wrapped the React application in a top-level error boundary so an uncaught render error no longer leaves users with a blank application surface.
- Added a bilingual, accessible recovery screen with retry and full-page reload actions.
- Browser console diagnostics retain the component stack for troubleshooting; stack details are not exposed in the UI.
- Added a regression test for error-boundary wiring and recovery affordances.

Validation: `npm run test:api` (117 tests passed). The Vite production build was not run in the packaging environment; run `npm install` and `npm run build` locally to validate the frontend bundle.

## Phase 76 — Actionable UI Error Diagnostics

- The global React error fallback now provides a user-triggered diagnostic report copy action.
- Error details can be expanded and copied manually if clipboard access is unavailable.
- Diagnostic reports include timestamp, page URL, browser user agent, error message, and stack trace.
- Reports are copied only after an explicit user action and are not transmitted to the server.
- Persian and English messages are supported.

Validation: `npm run test:api` — 118 tests passed. Frontend production build was not verified in the build environment because `npm ci` timed out.
"# ashkan-board" 
