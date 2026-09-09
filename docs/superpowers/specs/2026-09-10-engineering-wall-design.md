# Engineering Utilities Wall Design

ship.live becomes a passive engineering signal wall. It must not create tickets, missions, assignments, chat, or any workflow that team members must update. GitHub is the only CI/CD source; there are no provider-specific deployment integrations. Existing Service Health probes remain the runtime availability source.

## Signals

The GitHub App requests read-only Checks, Commit statuses, Actions, and Deployments permissions and subscribes to `pull_request`, `pull_request_review`, `check_run`, `status`, `workflow_run`, `deployment`, and `deployment_status`. The webhook route verifies the existing GitHub signature, installation, account, and repository boundary before accepting a signal. Current state is keyed by installation, repository, commit SHA, provider identity, and PR or deployment identity. Repeated deliveries are idempotent and older webhook updates cannot overwrite newer state.

Pull-request state contains title, author, draft/open state, head SHA, review decision signals, mergeability when supplied, and timestamps. Pipeline state normalizes queued, running, passing, failing, cancelled, and neutral outcomes from checks, commit statuses, and workflow runs. Deployment state normalizes queued, running, successful, failing, inactive, and cancelled states with environment and commit SHA. URLs are restricted to GitHub HTTPS URLs. Raw payloads, logs, annotations, secrets, and source code are not stored.

The server exposes an authorized wall snapshot with current PR, pipeline, deployment, health summary, and existing activity. Webhook deliveries are idempotent, browser snapshots repair missed live notifications, and explicit refresh reads the latest stored signal state. If a deployment system does not publish a GitHub signal, its stage is absent rather than inferred.

## Utilities

Review Radar orders actionable PRs: failing checks first, then merge-ready PRs, then PRs waiting for review. Drafts are excluded. “Ready” means the latest known checks pass and an approval exists; the UI says “Checks passing” when GitHub does not provide enough mergeability information. Waiting thresholds are display rules, not tasks.

Release Pulse shows the latest GitHub deployment for each repository and environment, together with known checks for its commit SHA. Service Health remains its own runtime scene. No deployment signal means the release scene is hidden.

What Changed deterministically summarizes the last 60 minutes and 24 hours from GitHub activity. It does not call an LLM and does not invent causal links.

Automatic Moments use the existing live merge, release, and milestone celebrations, and add recovery moments when CI, deployment, or service health returns to normal. There is no Mission model or mission UI. Effects use the existing reduced-motion, pause, visibility, replay, and celebration controls.

Attention Mode interrupts rotation for current service down, deployment failure, or CI failure in that priority order. It shows the source, age, affected repository/service, and GitHub link when available. Resolution produces one recovery moment and returns to the previous scene. First snapshots never replay celebration effects.

Smart Rotation cycles through Pulse, Review Radar, Release Pulse, Health, and Leaderboard. Empty scenes are skipped. Default dwell is 20 seconds; attention interrupts immediately. Interaction pauses for 60 seconds, manual previous/next controls remain available, and reduced motion pauses automatic rotation.

## Privacy and sharing

Private snapshots retain existing viewer/repository intersection and final authorization checks. Dashboard share links include wall signals only for their pinned repository scope. Shared views expose names, titles, states, durations, and GitHub URLs; they exclude probe targets, headers, conditions, raw CI output, logs, annotations, and provider credentials. Access loss, rotation, revocation, and expiry clear the wall state and close live streams.

## Product changes

The main Dashboard becomes the scene host. Service Health remains a separate configuration tab. Live feed, Team, Milestones, and Repositories remain available; existing automatic milestones appear in Moments and no new Team Mission concept is introduced.
