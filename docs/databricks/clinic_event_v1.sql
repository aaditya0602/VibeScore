-- VibeScore clinic_event_v1 reference schema for Databricks Delta.
-- The INSERT rows below are SYNTHETIC DEMO DATA. Never present them as pilot impact.

CREATE SCHEMA IF NOT EXISTS vibescore.hokie;

CREATE TABLE IF NOT EXISTS vibescore.hokie.clinic_event_v1 (
  event_id STRING NOT NULL,
  occurred_at TIMESTAMP NOT NULL,
  event_type STRING NOT NULL,
  cohort_id STRING NOT NULL,
  participant_key STRING NOT NULL,
  skill STRING,
  outcome_band STRING,
  usefulness_rating INT,
  consent_version STRING NOT NULL,
  schema_version INT NOT NULL,
  synthetic BOOLEAN NOT NULL
) USING DELTA;

ALTER TABLE vibescore.hokie.clinic_event_v1 ADD CONSTRAINT clinic_event_type
  CHECK (event_type IN ('readiness_started','readiness_completed','drill_started','drill_completed','rated_task_submitted','followup_completed','feedback_submitted'));
ALTER TABLE vibescore.hokie.clinic_event_v1 ADD CONSTRAINT clinic_skill
  CHECK (skill IS NULL OR skill IN ('framing','context','debugging','verification','review','efficiency'));
ALTER TABLE vibescore.hokie.clinic_event_v1 ADD CONSTRAINT clinic_band
  CHECK (outcome_band IS NULL OR outcome_band IN ('starting','developing','ready'));
ALTER TABLE vibescore.hokie.clinic_event_v1 ADD CONSTRAINT clinic_rating
  CHECK (usefulness_rating IS NULL OR usefulness_rating BETWEEN 1 AND 5);

-- SYNTHETIC: 10 reproducible participants so the suppression rule can be demonstrated.
-- Run once in a disposable demo schema or replace the event IDs before re-running.
INSERT INTO vibescore.hokie.clinic_event_v1
SELECT format_string('00000000-0000-4000-8000-%012d', id * 3 + 1), TIMESTAMP '2026-09-19 12:00:00',
       'readiness_started', 'SYNTHETIC_DEMO', format_string('synthetic-%02d', id + 1),
       NULL, NULL, NULL, 'synthetic-v1', 1, true
FROM range(10)
UNION ALL
SELECT format_string('00000000-0000-4000-8000-%012d', id * 3 + 2), TIMESTAMP '2026-09-19 12:02:00',
       'readiness_completed', 'SYNTHETIC_DEMO', format_string('synthetic-%02d', id + 1),
       CASE WHEN id < 6 THEN 'verification' ELSE 'context' END,
       CASE WHEN id < 4 THEN 'starting' ELSE 'developing' END, NULL, 'synthetic-v1', 1, true
FROM range(10)
UNION ALL
SELECT format_string('00000000-0000-4000-8000-%012d', id * 3 + 3), TIMESTAMP '2026-09-19 12:20:00',
       'drill_completed', 'SYNTHETIC_DEMO', format_string('synthetic-%02d', id + 1),
       CASE WHEN id < 6 THEN 'verification' ELSE 'context' END,
       NULL, NULL, 'synthetic-v1', 1, true
FROM range(8);

-- Organizer queries must keep synthetic/live data separate and suppress small cohorts.
CREATE OR REPLACE VIEW vibescore.hokie.clinic_cohort_summary_v1 AS
WITH cohort_counts AS (
  SELECT cohort_id, synthetic, COUNT(DISTINCT participant_key) AS participants,
         MAX(occurred_at) AS data_freshness
  FROM vibescore.hokie.clinic_event_v1
  GROUP BY cohort_id, synthetic
), event_counts AS (
  SELECT cohort_id, synthetic,
         COUNT(DISTINCT CASE WHEN event_type='readiness_started' THEN participant_key END) AS readiness_starts,
         COUNT(DISTINCT CASE WHEN event_type='readiness_completed' THEN participant_key END) AS readiness_completions,
         COUNT(DISTINCT CASE WHEN event_type='drill_started' THEN participant_key END) AS drill_starts,
         COUNT(DISTINCT CASE WHEN event_type='drill_completed' THEN participant_key END) AS drill_completions,
         COUNT(DISTINCT CASE WHEN event_type='rated_task_submitted' THEN participant_key END) AS rated_task_submissions,
         COUNT(DISTINCT CASE WHEN event_type='followup_completed' THEN participant_key END) AS followup_responses,
         COUNT(DISTINCT CASE WHEN event_type='feedback_submitted' THEN participant_key END) AS feedback_responses
  FROM vibescore.hokie.clinic_event_v1
  GROUP BY cohort_id, synthetic
)
SELECT c.cohort_id, c.synthetic, c.participants, c.data_freshness,
       e.readiness_starts, e.readiness_completions,
       try_divide(e.readiness_completions, e.readiness_starts) AS readiness_completion_rate,
       e.drill_starts, e.drill_completions,
       try_divide(e.drill_completions, e.drill_starts) AS drill_completion_rate,
       e.rated_task_submissions, e.followup_responses, e.feedback_responses
FROM cohort_counts c JOIN event_counts e USING (cohort_id, synthetic)
WHERE c.participants >= 10;

-- Largest consented baseline gaps, kept separate for live and synthetic cohorts.
CREATE OR REPLACE VIEW vibescore.hokie.clinic_skill_gaps_v1 AS
SELECT cohort_id, synthetic, skill, COUNT(DISTINCT participant_key) AS participants_with_gap,
       MAX(occurred_at) AS data_freshness
FROM vibescore.hokie.clinic_event_v1
WHERE event_type='readiness_completed' AND outcome_band IN ('starting','developing') AND skill IS NOT NULL
GROUP BY cohort_id, synthetic, skill
HAVING COUNT(DISTINCT participant_key) >= 10;
