# Team follow-through design

Approved scope: user selected proposals 1, 2, 4 and 5 on 2026-09-15.

## Review Radar

Show grounded current reasons and age. Workspace members may claim an authorized PR; claims cannot overwrite another member. A viewer may snooze their own reminder for a bounded duration. Bind follow-through to current PR/head and attention state so closure, merge or resolution makes old actions obsolete. Shared dashboards stay read-only. Historical views label current status and do not permit misleading historical mutations.

## Overview comparison

Compare all retained authorized contributions with the immediately preceding UTC calendar interval of equal length. Show merges, reviews, releases and distinct human participants, absolute deltas and drilldowns. State incomplete current periods and limited coverage for each interval. Preserve demo, personal scope, deduplication and share-token boundaries. Bind activity pagination to type as well as dates and repository.

## Saved views

Persist at most 30 private named views per account, synchronized across browsers through PostgreSQL. A view stores only a validated internal route and explicit workspace ID, never cached data or tokens. Presets (today, 7d, 30d, month) remain dynamic; custom dates remain fixed. Create, rename, update-to-current and delete are supported. Opening uses existing authorized workspace navigation; stale access fails closed without fallback. Available from the authenticated page tools.

## Weekly recap

An authenticated recap page selects completed UTC Monday-Sunday weeks and derives authorized weekly highlights using the existing bounded digest summary. Current help-needed items are labeled as current. Reflections are private per viewer/workspace/week to avoid prose crossing repository permission boundaries; UI states this. Export the visible summary and reflection as Markdown. Workspace digest scheduling selects local weekday, time and IANA timezone, defaults Monday09:00UTC, and handles DST and replica idempotence. The weekly reporting basis stays UTC and is distinct from the local delivery schedule.

## Architecture and compatibility

Dedicated routers, stores and UI modules for new features; existing viewer authorization validates read scope again after asynchronous reads. Mutations require session+CSRF. All new tables fit one additive migration022 so the prior released schema compatibility window remains valid. Enable RLS and revoke browser roles. Preserve stale-response guards on account/workspace/access changes. No external messages, merge, release or deployment are part of this feature request.

## Validation

Write and observe failing behavior tests before implementation. Cover real PostgreSQL ownership and permission boundaries, atomic claims, snooze expiry, complete comparison totals and pagination, dynamic/fixed saved views, recap scope and scheduler DST/idempotence. Browser tests exercise navigation, errors, mutation feedback and account changes. Finish with formatting, database suite, browser suite, build and deployment compatibility checks.
