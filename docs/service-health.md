# Service Health

Service Health monitors public HTTP APIs from the ship.live server, even when nobody has the dashboard open. Open a team workspace, select the **Service Health** tab, choose **Add service**, then **Add probe**. Each service can contain multiple probes. Signed-in team members with current access can manage them; personal journals do not expose health data. Dashboard and Service Health use separate share links.

## Configure a probe

- **Endpoint and method:** public HTTP/HTTPS URL with GET or HEAD. Redirects are not followed. Use the final endpoint URL. HEAD cannot check a JSON response.
- **Interval:** 30–3600 seconds; default 60. The next check is scheduled after the previous check finishes. Busy workers can start later; missed intervals are not replayed in a burst.
- **Timeout:** 1000–20000 milliseconds; default 10000. Includes DNS lookup, connection and reading the response.
- **Healthy conditions:** all configured checks must pass. Choose an accepted HTTP status range (default 200–299), optional maximum latency, and optional JSON path with an exact expected primitive value. For `{"health":{"ready":true}}`, enter `health.ready` and `true`. Array positions can use numeric path segments such as `items.0.status`. To select the first matching object in an array by a stable primitive property, use `components[?(@.name=="Embeddings")].status`. Text values need JSON quotes, such as `"ok"`. Conditions never execute code.
- **Thresholds:** 1–10 consecutive failures before Down (default 3), and 1–10 successes to recover from Down (default 2).
- **Secret headers:** a JSON object such as `{"Authorization":"Bearer …"}`. Stored encrypted and never returned to the browser. On edit, leave blank to preserve existing headers, supply an object to replace them, or select **Remove all saved headers**. Put credentials in headers rather than endpoint query parameters.

A team can configure up to 20 services and 100 probes. Response bodies are limited to 64 KiB and are not stored. Private, loopback, link-local and reserved addresses are rejected, including DNS results; these probes cannot monitor internal network services.

## Filter a JSON response

JSON paths accept dot-separated properties, numeric array positions such as `items.0.status`, and restricted equality filters such as `components[?(@.name=="Embeddings")].status`. A filter selects the **first** array object whose named property exactly matches the supplied JSON primitive, then continues through the remaining path. If multiple objects match, later objects are ignored. A missing property, no matching object, a filter applied to a non-array, or traversal through a primitive fails the condition.

Filter values and expected values may be strings, finite numbers, booleans, or `null`. Comparisons are exact and preserve types: `42` differs from `"42"`, `true` differs from `"true"`, and text is case-sensitive. Strings use JSON double quotes and escaping. For example, `regions[?(@.primary==true)].health.ready` can be compared with `true`, and `components[?(@.id==42)].state` can be compared with `"ready"`.

For an OpenAI-style status response containing the following components:

```json
{
  "components": [
    { "name": "Embeddings", "status": "operational" },
    { "name": "Chat Completions", "status": "operational" }
  ]
}
```

Configure separate GET probes against the public status JSON endpoint with these conditions:

| Component        | JSON path                                          | Expected JSON value |
| ---------------- | -------------------------------------------------- | ------------------- |
| Embeddings       | `components[?(@.name=="Embeddings")].status`       | `"operational"`     |
| Chat Completions | `components[?(@.name=="Chat Completions")].status` | `"operational"`     |

These examples select by component name even if the array order changes. A renamed, missing, or non-operational component fails its condition. This monitors the status response; it does not call the Embeddings or Chat Completions API itself.

Paths are limited to 256 characters. This is a restricted path syntax: wildcards, recursive descent, slices, unions, regexes, nested property expressions inside filters, and operators other than `==` are unsupported. Prototype-related property names are rejected. Invalid syntax is rejected when saving the probe.

## Arrange services

Use the **Reorder [service name]** handle beside a service to drag it up or down, including when its row is expanded. On touch screens, press and hold the handle before dragging. With a keyboard, focus the handle, press **Space** to pick up, use **Arrow Up/Down** to move, and press **Space** to drop. **Escape** cancels the move.

The list updates immediately on drop and saves the order for the team workspace. Other signed-in viewers and public health shares receive that same order when they refresh. Reloading preserves it; new services append at the end. Reordering services keeps each service's probes and history attached and does not change probe order. The handle is unavailable when there are fewer than two services.

While an order save is pending, another reorder is unavailable. Failed saves restore the prior order and display an error; the next refresh reconciles the list with the server. Live snapshots arriving during a drag are held until the interaction finishes.

## Read the dashboard

**Healthy** means the most recent check passed. **Degraded** means failures have started but have not reached the Down threshold. **Down** remains until the configured consecutive recovery checks pass. **Unknown** means there is no result or the last check is older than twice its interval plus timeout. **Paused** disables scheduled checks.

A service uses its worst active probe status: Down, Degraded, Unknown, then Healthy. If every probe is paused, the service is Paused. A service without probes is Unknown.

Services start collapsed so more of the team can be scanned at once. Each row shows its current status, probe count and the 20 most recent service-level status blocks; green is Healthy, yellow is Degraded, red is Down and grey is Unknown or missing data. The newest block is on the right. Mobile shows the newest 10 blocks. Open a row to see its probes, latency charts and management actions; opening another row closes the previous one.

The dashboard shows latency, last check, the last 120 retained check results, and transitions within those results. Each service row shows its **uptime** and **latency** for the last 24 hours, and its info button explains both. Uptime is the percentage of recorded checks that passed, weighted across the service’s probes by how many checks each recorded; it is not time-weighted availability, and missing checks never count as passing. Latency is the mean ± population standard deviation of every recorded check’s response time, including failed checks and timeouts. Each probe’s **Check success · 24h** is the same pass rate for that probe alone. Signed-out visitors can explore a read-only Service Health demo with fictional services. Raw results are retained for at least 30 days and pruned hourly. Each probe has three latency views that span the full card width: **Recent checks** (the last 120 results), **24 hours** (averages over aligned 15-minute windows, computed from retained checks when the snapshot is read) and **30 days** (daily UTC averages). Averages include failed checks and timeouts, with gaps for windows or days without checks. Daily aggregates are updated transactionally so live snapshots read at most 30 buckets per probe. Changing the endpoint, probe rules, interval or credentials resets current state and thresholds but preserves recorded history; renaming or pausing/resuming also preserves thresholds. Explicitly deleting a probe or service deletes its history.

Hover over a latency chart or tap it to select the nearest recorded point by horizontal position. Recent-check tooltips show local date and time, latency, Passed/Failed, and an HTTP status when available. **24 hours** tooltips show the local window start; **30 days** tooltips show the UTC date. Both show the average, minimum, maximum, and check count. Windows and days without checks remain gaps and cannot be selected.

Each populated chart is one keyboard stop: focus it, use **Arrow Left/Right** to move between recorded points, and use **Home/End** for the first/last point. **Escape** dismisses the tooltip, including one opened by hover while focus is elsewhere. Moving the mouse out dismisses a hover selection. Touch selection persists after lifting your finger; selecting another point, changing the range, moving focus away, or pressing Escape changes or dismisses it. The active description is associated with the chart for assistive technology, and the expandable latency data table remains available.

New Down and recovery transitions highlight and announce on the dashboard. The first loaded snapshot does not trigger alerts. Motion respects reduced-motion preferences. This release provides in-dashboard visibility; it does not send external notifications.

**Check now** queues an enabled probe for the next worker tick. Already running checks and checks completed within ten seconds cannot be queued again. Pause, edit or delete invalidates any running result for that definition.

## Share service health

From the **Service Health** tab, choose **Share service health**. Anyone with the link can view the team's current and future service names, probe names, statuses, latency, check success and recent history without signing in. Endpoint URLs, secret headers and condition values are excluded. Viewers cannot change configuration or queue checks.

Choose a lifetime from 1 hour through 10 years, or **No expiration**. No expiration is represented by a 100-year lifetime so it uses the same expiration, rotation and revocation safeguards. Copy the newly created link; its secret token is shown only when created or rotated. **Rotate** creates a new link and invalidates the old one. **Revoke** immediately withdraws the link. Existing live viewers are disconnected on revoke/rotation and when a finite lifetime ends; the page clears its data. Creator membership, connected GitHub account generation and current access are revalidated.

Health shares use `/share/health#…` and are independent of `/share#…` dashboard links. Rotating one does not affect the other. Tokens are stored as hashes and sent in request headers, not query strings. Link metadata is scoped to its creator and team.

## Resume a workspace

After sign-in, ship.live restores the last selected workspace in this browser for that account. An explicit workspace choice or a successfully connected installation saves the choice. Choosing demo leaves the previous saved choice intact. The preference contains only a workspace ID and is separate for each authenticated account; logout clears private in-memory data while allowing the same account to resume later.

Restoration waits for the freshly authorized workspace list. If the saved workspace is missing or access has been revoked, the app selects the personal journal, then the first authorized workspace, and saves that fallback. If no workspace is available, it stays in demo. Stored preferences never grant access or display cached private workspace data. Blocked or full browser storage does not prevent loading, switching workspaces, or logout, though the choice may not survive reload. The old pre-sign-in organization preference is not restored.

## Run and deploy

The existing server process starts the scheduler automatically. No external cron or additional service is required. PostgreSQL stores the schedule and coordinates replicas with expiring leases; each process runs at most four probes concurrently. Restarted workers reclaim expired leases, and overdue results remain visibly Unknown until a new check succeeds or fails.

Migrations `006_service_health.sql`, `007_health_shares.sql`, `008_health_latency_daily.sql` and `010_health_service_order.sql` run through the existing migration mechanism. Set the existing `TOKEN_ENCRYPTION_KEY` (32 bytes encoded as 64 hexadecimal characters) to use secret headers. Replacing this key makes old headers unreadable; update or clear headers through the UI to repair affected probes. Health snapshots and live updates load separately from the GitHub activity feed.
