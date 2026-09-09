# Service Health

Service Health monitors public HTTP APIs from the ship.live server, even when nobody has the dashboard open. Open a team workspace, select the **Service Health** tab, choose **Add service**, then **Add probe**. Each service can contain multiple probes. Signed-in team members with current access can manage them; personal journals do not expose health data. Dashboard and Service Health use separate share links.

## Configure a probe

- **Endpoint and method:** public HTTP/HTTPS URL with GET or HEAD. Redirects are not followed. Use the final endpoint URL. HEAD cannot check a JSON response.
- **Interval:** 30–3600 seconds; default 60. The next check is scheduled after the previous check finishes. Busy workers can start later; missed intervals are not replayed in a burst.
- **Timeout:** 1000–20000 milliseconds; default 10000. Includes DNS lookup, connection and reading the response.
- **Healthy conditions:** all configured checks must pass. Choose an accepted HTTP status range (default 200–299), optional maximum latency, and optional JSON path with an exact expected primitive value. For `{"health":{"ready":true}}`, enter `health.ready` and `true`. Text values need JSON quotes, such as `"ok"`. Array positions can use numeric path segments. Conditions never execute code.
- **Thresholds:** 1–10 consecutive failures before Down (default 3), and 1–10 successes to recover from Down (default 2).
- **Secret headers:** a JSON object such as `{"Authorization":"Bearer …"}`. Stored encrypted and never returned to the browser. On edit, leave blank to preserve existing headers, supply an object to replace them, or select **Remove all saved headers**. Put credentials in headers rather than endpoint query parameters.

A team can configure up to 20 services and 100 probes. Response bodies are limited to 64 KiB and are not stored. Private, loopback, link-local and reserved addresses are rejected, including DNS results; these probes cannot monitor internal network services.

## Read the dashboard

**Healthy** means the most recent check passed. **Degraded** means failures have started but have not reached the Down threshold. **Down** remains until the configured consecutive recovery checks pass. **Unknown** means there is no result or the last check is older than twice its interval plus timeout. **Paused** disables scheduled checks.

A service uses its worst active probe status: Down, Degraded, Unknown, then Healthy. If every probe is paused, the service is Paused. A service without probes is Unknown.

Services start collapsed so more of the team can be scanned at once. Each row shows its current status, probe count and the 20 most recent service-level status blocks; green is Healthy, yellow is Degraded, red is Down and grey is Unknown or missing data. The newest block is on the right. Mobile shows the newest 10 blocks. Open a row to see its probes, latency charts and management actions; opening another row closes the previous one.

The dashboard shows latency, last check, the last 120 retained check results, and transitions within those results. **Check success · 24h** is the percentage of recorded checks that passed, not time-weighted uptime. Missing checks are never counted as successes. Raw results are retained for at least 30 days and pruned hourly. Each probe has recent-check and 30-day latency charts; daily UTC averages include failed checks and timeouts, with gaps for days without checks. Daily aggregates are updated transactionally so live snapshots read at most 30 buckets per probe. Changing the endpoint, probe rules, interval or credentials resets current state and thresholds but preserves recorded history; renaming or pausing/resuming also preserves thresholds. Explicitly deleting a probe or service deletes its history.

New Down and recovery transitions highlight and announce on the dashboard. The first loaded snapshot does not trigger alerts. Motion respects reduced-motion preferences. This release provides in-dashboard visibility; it does not send external notifications.

**Check now** queues an enabled probe for the next worker tick. Already running checks and checks completed within ten seconds cannot be queued again. Pause, edit or delete invalidates any running result for that definition.

## Share service health

From the **Service Health** tab, choose **Share service health**. Anyone with the link can view the team's current and future service names, probe names, statuses, latency, check success and recent history without signing in. Endpoint URLs, secret headers and condition values are excluded. Viewers cannot change configuration or queue checks.

Choose a lifetime from 1 hour through 10 years, or **No expiration**. No expiration is represented by a 100-year lifetime so it uses the same expiration, rotation and revocation safeguards. Copy the newly created link; its secret token is shown only when created or rotated. **Rotate** creates a new link and invalidates the old one. **Revoke** immediately withdraws the link. Existing live viewers are disconnected on revoke/rotation and when a finite lifetime ends; the page clears its data. Creator membership, connected GitHub account generation and current access are revalidated.

Health shares use `/share/health#…` and are independent of `/share#…` dashboard links. Rotating one does not affect the other. Tokens are stored as hashes and sent in request headers, not query strings. Link metadata is scoped to its creator and team.

## Run and deploy

The existing server process starts the scheduler automatically. No external cron or additional service is required. PostgreSQL stores the schedule and coordinates replicas with expiring leases; each process runs at most four probes concurrently. Restarted workers reclaim expired leases, and overdue results remain visibly Unknown until a new check succeeds or fails.

Migrations `006_service_health.sql`, `007_health_shares.sql` and `008_health_latency_daily.sql` run through the existing migration mechanism. Set the existing `TOKEN_ENCRYPTION_KEY` (32 bytes encoded as 64 hexadecimal characters) to use secret headers. Replacing this key makes old headers unreadable; update or clear headers through the UI to repair affected probes. Health snapshots and live updates load separately from the GitHub activity feed.
