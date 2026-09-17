-- Resolve lifetime review credit before applying a date range or feed limit.
CREATE INDEX ship_live_review_credit_idx ON ship_live_events
  (organization, lower(event->>'repo'), (event->>'number'), lower(btrim(event #>> '{actor,login}')), occurred_at, event_id COLLATE "C")
  WHERE event->>'type'='review';
CREATE INDEX ship_live_pr_author_idx ON ship_live_events
  (organization, lower(event->>'repo'), (event->>'number'), occurred_at, event_id COLLATE "C")
  WHERE event->>'type' IN ('pr','merge');
CREATE INDEX ship_live_review_credit_repo_id_idx ON ship_live_events
  (organization, (event->>'repositoryId'), (event->>'number'), lower(btrim(event #>> '{actor,login}')), occurred_at, event_id COLLATE "C")
  WHERE event->>'type'='review';
CREATE INDEX ship_live_pr_author_repo_id_idx ON ship_live_events
  (organization, (event->>'repositoryId'), (event->>'number'), occurred_at, event_id COLLATE "C")
  WHERE event->>'type' IN ('pr','merge');
