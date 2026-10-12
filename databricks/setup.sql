-- VibeScore Hokie Career Navigator
-- Run in a Databricks SQL warehouse. Change the catalog/schema here and in
-- the VibeScore DATABRICKS_* environment settings if you do not use vibescore.hokie.

CREATE CATALOG IF NOT EXISTS vibescore;
CREATE SCHEMA IF NOT EXISTS vibescore.hokie;

CREATE TABLE IF NOT EXISTS vibescore.hokie.campus_resources (
  resource_id STRING NOT NULL,
  name STRING NOT NULL,
  description STRING NOT NULL,
  url STRING NOT NULL,
  skill_tags STRING NOT NULL,
  career_tags STRING NOT NULL,
  source STRING NOT NULL,
  last_verified_at TIMESTAMP NOT NULL
) USING DELTA;

MERGE INTO vibescore.hokie.campus_resources AS target
USING (
  SELECT * FROM VALUES
    ('vt-interview-prep', 'Prepare for an Interview', 'Virginia Tech guidance, mock-interview tools, common questions, research, and follow-up advice.', 'https://career.vt.edu/channels/prepare-for-an-interview/', 'framing,context,verification,review', 'interview,internship,job,graduate school', 'Virginia Tech Career and Professional Development', TIMESTAMP '2026-09-19 00:00:00'),
    ('vt-resume-cv', 'Resumes and CVs', 'Resume planning, examples, VMock feedback, ATS guidance, and appointments with career advisors.', 'https://career.vt.edu/channels/resume-cv/', 'context,review,efficiency', 'resume,cv,internship,job,portfolio', 'Virginia Tech Career and Professional Development', TIMESTAMP '2026-09-19 00:00:00'),
    ('vt-career-topics', 'Career Readiness Toolkit', 'Interactive resources for professional competencies, interviews, resumes, and career-development workshops.', 'https://career.vt.edu/resources/resources-by-career-topic/', 'framing,context,review,efficiency', 'career,interview,resume,workshop,competencies', 'Virginia Tech Career and Professional Development', TIMESTAMP '2026-09-19 00:00:00'),
    ('vt-informational-interviews', 'Informational Interviews', 'A practical guide to learning about roles and industries through structured conversations with professionals.', 'https://career.vt.edu/resources/informational-interviews/', 'framing,context,review', 'networking,career exploration,industry,interview', 'Virginia Tech Career and Professional Development', TIMESTAMP '2026-09-19 00:00:00'),
    ('vt-technical-interviews', 'Technical Interview Guidance', 'Virginia Tech advice on fundamentals, communicating reasoning, asking questions, and practising technical interviews.', 'https://tips.career.vt.edu/Interviews/during/technical.html', 'debugging,verification,framing,context', 'technical interview,software engineering,practice', 'Virginia Tech Career Quick Start', TIMESTAMP '2026-09-19 00:00:00'),
    ('vt-cs-students', 'Computer Science Student Resources', 'Virginia Tech Computer Science information and resources for current majors, minors, and graduate students.', 'https://students.cs.vt.edu/', 'context,efficiency', 'computer science,student,academic,career', 'Virginia Tech Department of Computer Science', TIMESTAMP '2026-09-19 00:00:00')
  AS resources(resource_id, name, description, url, skill_tags, career_tags, source, last_verified_at)
) AS source
ON target.resource_id = source.resource_id
WHEN MATCHED THEN UPDATE SET
  name = source.name,
  description = source.description,
  url = source.url,
  skill_tags = source.skill_tags,
  career_tags = source.career_tags,
  source = source.source,
  last_verified_at = source.last_verified_at
WHEN NOT MATCHED THEN INSERT *;

SELECT resource_id, name, skill_tags, career_tags, source, last_verified_at
FROM vibescore.hokie.campus_resources
ORDER BY name;
