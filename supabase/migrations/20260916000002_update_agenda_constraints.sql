/*
 * Update agenda constraints and trigger to allow:
 * - 0-4 speakers (was 1-4)
 * - 2000 character description (was 650)
 */

-- Drop existing constraint
ALTER TABLE public.agenda
DROP CONSTRAINT IF EXISTS agenda_description_length;

-- Add new constraint with 2000 character limit
ALTER TABLE public.agenda
ADD CONSTRAINT agenda_description_length
CHECK (description is null or char_length(description) <= 2000)
NOT VALID;

-- Recreate trigger to allow 0-4 speakers (not 1-4)
DROP TRIGGER IF EXISTS validate_agenda_speakers_trigger ON public.agenda;

CREATE OR REPLACE FUNCTION public.validate_agenda_speakers()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  speaker_count INTEGER;
  speakers_data JSONB;
BEGIN
  IF TG_OP = 'INSERT' OR (new.speakers IS DISTINCT FROM old.speakers) THEN
    IF new.speakers IS NULL THEN
      speakers_data := '[]'::jsonb;
    ELSE
      speakers_data := new.speakers;
    END IF;

    IF jsonb_typeof(speakers_data) = 'array' THEN
      speaker_count := jsonb_array_length(speakers_data);
    ELSE
      speaker_count := 0;
    END IF;

    IF speaker_count > 4 THEN
      RAISE EXCEPTION 'Agenda can have at most 4 speakers.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN new;
END;
$$;

CREATE TRIGGER validate_agenda_speakers_trigger
BEFORE INSERT OR UPDATE ON public.agenda
FOR EACH ROW
EXECUTE FUNCTION public.validate_agenda_speakers();
