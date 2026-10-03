-- Canonicalize video render modes used by the agent orchestrator and renderer.
-- The legacy constraint only allowed static/legacy names, while production
-- already dispatches these three modes through agent_videos.type.

DO $$
DECLARE
  constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT DISTINCT c.conname
    FROM pg_constraint c
    JOIN unnest(c.conkey) WITH ORDINALITY AS constrained_attribute(attnum, position) ON true
    JOIN pg_attribute a
      ON a.attrelid = c.conrelid
     AND a.attnum = constrained_attribute.attnum
    WHERE c.conrelid = 'public.agent_videos'::regclass
      AND c.contype = 'c'
      AND a.attname = 'type'
      AND array_length(c.conkey, 1) = 1
  LOOP
    EXECUTE format('ALTER TABLE public.agent_videos DROP CONSTRAINT %I', constraint_row.conname);
  END LOOP;
END $$;

UPDATE public.agent_videos
SET type = 'static_cover'
WHERE type IN ('lyric_video', 'short', 'teaser');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_videos_type_check'
      AND conrelid = 'public.agent_videos'::regclass
  ) THEN
    ALTER TABLE public.agent_videos
      ADD CONSTRAINT agent_videos_type_check
      CHECK (type IN ('static_cover', 'image_animation', 'full_scenes'));
  END IF;
END $$;
