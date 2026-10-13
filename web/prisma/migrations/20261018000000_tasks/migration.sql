-- Data only (no schema change): what was a "story" is now a "task".
-- The tables keep their names (story_*) behind Prisma's @@map.
-- Data: what was a "story" is now a "task" (the tables keep their names).
UPDATE "story_job" SET "kind" = replace("kind", 'story-', 'task-') WHERE "kind" LIKE 'story-%';

-- Data: sessions MAW ran for a task were titled "Story N · …"; they take the task's title.
UPDATE "project_session" AS ps
SET "title" = left(s."title", 48) || ' · ' || regexp_replace(ps."title", '^Story [0-9]+ · ', '')
FROM "story_job" AS j JOIN "story" AS s ON s."id" = j."storyId"
WHERE j."sessionId" = ps."id" AND ps."title" ~ '^Story [0-9]+ · ';
-- …and those of tasks removed since keep what they were.
UPDATE "project_session" SET "title" = 'Removed task · ' || regexp_replace("title", '^Story [0-9]+ · ', '') WHERE "title" ~ '^Story [0-9]+ · ';
