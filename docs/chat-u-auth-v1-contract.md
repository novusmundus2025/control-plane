# Chat-U Per-User Authentication v1

Status: UAT implementation contract  
Scope: browser Chat-U and Coding Harness submission  
Production authority: none

## Identity and session authority

- Every browser chat, conversation, and Harness request requires one active `public.users` record.
- GitHub and verified email are linked identities for the same internal user; provider identifiers are never used as authorization decisions by themselves.
- GitHub sign-in uses the OAuth web flow with an unguessable `state` and PKCE S256. The callback revalidates the user through GitHub's API. Access tokens are discarded after identity verification.
- Email sign-in uses a single-use, short-lived random link. Only a SHA-256 digest is stored. Responses do not reveal whether an account already exists.
- Browser sessions are opaque random values. PostgreSQL stores only their SHA-256 digests. Cookies are host-only, `Secure`, `HttpOnly`, `SameSite=Lax`, and have a bounded absolute lifetime.
- Logout and expiry revoke server-side authority. Session identifiers are never stored in local storage.

## Authorization

- Chat access and Harness access are separate decisions.
- A signed-in user may chat, but may submit Harness work only through an active `user_repository_grants` row.
- Tenant, repository, path prefixes, validation profiles, and execution modes come from that server-side grant. Browser payloads cannot override them.
- A Harness task records `requested_by_user_id` and `submitted_via=chat-u` immutably.
- Users may read only their own Harness tasks and cannot create execution approvals.
- EHDA operator UAT approval remains separate. Merge and deployment remain separate approvals.

## Deployment gates

- GitHub login is enabled only when client ID, client secret, public origin, and PostgreSQL are configured.
- Email login is enabled only when the email provider key and verified sender are configured.
- When authentication is required but storage is unavailable, Chat-U fails closed with `503`; it never falls back to anonymous access.
- UAT must verify OAuth state/PKCE rejection, one-time-link replay rejection, session revocation, horizontal-access rejection, repository-grant enforcement, and unauthenticated API rejection.

## Primary references

- GitHub OAuth web application flow: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
- GitHub verified email API: https://docs.github.com/en/rest/users/emails
- OWASP Node.js session cookie guidance: https://cheatsheetseries.owasp.org/cheatsheets/Nodejs_Security_Cheat_Sheet.html
- OWASP CSRF guidance: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- Resend email API: https://resend.com/docs/api-reference/emails/send-email
