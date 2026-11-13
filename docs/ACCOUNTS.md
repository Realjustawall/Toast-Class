# Account and registration controls

Email/password registration and sign-in now use a shared HTTP response reader that handles empty, HTML and truncated proxy responses. It never blindly retries a mutation. The reported JSON exception was traced to Vite `ECONNREFUSED 127.0.0.1:3001` while the development API watcher restarted during registration. The preview API is now a separate non-watching process; frontend updates remain available on port 5173. Browser tests can run on TEST_WEB_PORT=15173 without disrupting that preview.

The user-requested policy is **6–128 characters**, applied to registration, sign-in validation and password changes. The two requested explanatory paragraphs were removed from the UI and translations. Passwords remain scrypt-hashed with random salts. Confirmation, show/hide, field errors and remembered/session-only cookies are implemented. Remembered sessions expire in seven days; session-only cookies have no Max-Age and server sessions expire after twelve hours. Email verification/reset/MFA/passkeys/enterprise identity are still outstanding; this is not a complete identity milestone.

Every user has **My account / حساب من**: persisted name, language and timezone, password change with current-password verification, up to 100 active sessions, per-device revocation, revoke-other-devices and the latest 50 personal security events. Session identifiers are separate from token hashes; session lists expose neither tokens nor hashes. Password changes invalidate other sessions, preserve the current session and serialize with sign-in using a user row lock. Sensitive content/IPs are not collected in these security-event records. Device descriptions are bounded user-agent strings, not verified hardware identities.

## Platform administrator and registration lock

Platform administrators are explicit entries in `platform_admins`. Creating an organization does not grant platform authority. Bootstrap a chosen registered account from the trusted server shell:

```sh
npm run admin:grant -- administrator@example.org
```

This operator command uses DATABASE_URL from the local environment and never accepts a role from signup data. Refresh/sign in afterward to show **Platform settings / تنظیمات سامانه**. The command and current preview now use the native MySQL database factory. PostgreSQL remains an optional source/regression backend.

The settings page closes/reopens registration. Public status polling is advisory; the registration API checks and locks the singleton settings row in the account-creation transaction. Closure and registration serialize. Updates use expectedRevision, reject stale changes and emit a personal security event. Existing account sign-in works while signup is closed. No browser-only flag can bypass the lock. Registration state is persistent. There is no production auto-bootstrap or test privilege endpoint.

APIs under `/api/v1`:

- GET `/account`, POST `/account/profile` (`name,locale,timezone`)
- GET `/account/sessions`, POST `/account/sessions/:id/revoke`, POST `/account/sessions/revoke-others`
- POST `/account/password` (`currentPassword,newPassword`)
- GET `/account/security`
- GET `/auth/registration` (public `open` only)
- GET/POST `/platform/registration` (platform admin; POST `open,expectedRevision`)

Migrations 012/013 preserve existing users and give existing sessions public UUIDs. Account endpoints reject unauthenticated access; session mutations scope by account. Profile payloads reject role/privilege injection.

`tests/account.test.ts`, `tests/registration.test.ts` and `tests/http-response.test.ts` cover the implemented boundaries. Real-browser account and registration-lock specs passed in installed Windows Chrome. `TEST_PLATFORM_ADMIN_SEED=true` explicitly enables fixture setup in the ephemeral test server, never in production. The fixture inserts the platform role directly in its isolated test database; it adds no privileged HTTP bypass. SQL-shaped payloads are tested as literal data. This does not certify every possible injection boundary or the future full MySQL application.
