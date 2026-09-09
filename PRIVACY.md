# ship.live privacy notice

Effective September 9, 2026.

This notice covers the ship.live instance operated by Duy Huynh at
[site--ship-live--dzy2bm2fnwqk.code.run](https://site--ship-live--dzy2bm2fnwqk.code.run).
The [open-source project](https://github.com/vndee/ship.live) can also be hosted by
other operators. Their deployments have their own privacy practices; this notice
does not cover them.

## Information the service uses

- **Account information.** When you sign in with an available Google or GitHub
  provider, Supabase Auth receives your basic identity, including your email,
  name, profile picture, and provider identifier. ship.live stores your account
  identifier, display name, and optional profile-picture URL to identify your
  journal and display your profile. Google sign-in requests only basic identity
  information; it does not request Gmail, Drive, Calendar, or repository access.
- **Journal notes.** The service stores the titles, bodies, timestamps, and
  ownership information of notes you create.
- **GitHub activity, if you connect a configured GitHub App.** A separate
  authorization grants access to selected repositories. The service stores
  connection and installation identifiers, encrypted GitHub authorization
  tokens, repository metadata, and activity records such as pull requests,
  reviews, releases, issues, and pushes. Records may include titles, descriptions,
  commit messages, contributors, timestamps, and links. Signing in alone does
  not grant repository access.
- **Session and technical information.** Essential cookies and server-side
  session records support authentication and protect requests. Hosting and
  authentication providers may process IP addresses, request metadata, and
  diagnostic logs to deliver and secure the service.

This information is used to authenticate accounts, maintain private journals,
synchronize authorized GitHub activity, display activity visualizations, and
operate and troubleshoot the service. The application has no advertising,
analytics trackers, or AI-training pipeline. Its fonts are bundled locally.

## Access and service providers

Personal notes are available only to their owner through the application. GitHub
activity is filtered according to the repositories each signed-in viewer can
currently access. A team member can also create an expiring, read-only dashboard
link. Anyone with that link can view contributor names, XP, repository names, and
GitHub activity titles within its scope, including private repository activity.
The scope remains limited by the creator’s current repository permissions.
Personal notes and event bodies are excluded; public journal publishing is not
implemented.

The hosted service uses **Northflank** for the application and **Supabase** for
authentication and PostgreSQL storage, with application and database resources
in the United States. Google or GitHub processes sign-in requests when you choose
that provider. GitHub processes repository authorization and synchronization when
you connect it. Profile images may load directly from the sign-in provider.

For more information about these providers' privacy practices, see
[Northflank](https://northflank.com/legal/privacy),
[Supabase](https://supabase.com/privacy),
[Google](https://policies.google.com/privacy), and
[GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

HTTPS protects traffic to the hosted app, and its database connection uses
certificate-verified TLS. Session cookies are HttpOnly and Secure on HTTPS.
Private information is not end-to-end encrypted: authorized service operators
and infrastructure providers may be able to access stored data for operation
and support. Access controls do not make the service immune to security incidents.

## Retention and your choices

Account records, notes, and stored activity do not have an automatic retention
deadline in the current version. Deleting a note removes it from the application's
active database. A 24-hour or 30-day activity filter is a display filter, not a
data-deletion schedule.

You can rotate or revoke your own dashboard links in the Share dialog. Links
expire after the chosen duration; rotation immediately replaces the previous
link. Only a hash of each link token is stored, along with its creator, workspace,
repository scope, and expiration. Expiration disables access but does not delete
the underlying activity or recall copies already made by viewers.

You can delete your own notes and disconnect GitHub in the app. Disconnecting
removes your stored GitHub user grant and workspace associations, while retaining
your notes and previously stored activity. Uninstall or suspend the GitHub App
in GitHub to stop webhooks for that installation. Revoking Google or GitHub
authorization does not itself delete your ship.live account or stored data.

There is not yet a self-service account-deletion or data-export screen. Contact
**vndee.huynh@gmail.com** to request access to or removal of your hosted account
data, or to ask privacy questions. Do not include private journal or repository
content in public GitHub issues. Provider-managed logs and any backups may have
separate retention schedules.

Changes to this notice will be published here with an updated effective date.
