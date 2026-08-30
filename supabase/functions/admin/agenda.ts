// Creating and editing agenda events, for the admin tooling:
//
//   POST admin/agenda/create   { "name": "...", ... }
//   POST admin/agenda/update   { "id": "...", ...fields to change }
//
// Nothing in the app calls these — the app only ever reads the agenda (see
// user/agenda.ts) — so they exist for whoever is loading the schedule in from
// Postman or a back-office screen. They are edge routes rather than direct REST
// writes because one event is three tables: public.agenda, its tags in
// public.agenda_guilds, and its Builder/Operator/Explorer audiences in
// public.agenda_user_types.
//
// Every reference to public.configs or public.guilds may be given as an id or as
// a name ("Main Quests", "Day 1", "AI"). Names are the useful form here: configs
// ids come from one shared sequence and differ between environments, which is the
// same reason public.award_agenda_mission() and questSection() in user/agenda.ts
// match on the name.
import { readBoolean, readInt } from "../_shared/fields.ts";
import { fail, integer, ok, text } from "../_shared/http.ts";
import { logDbFailure, serviceClient } from "../_shared/supabase.ts";

// The check constraint added (NOT VALID) in 20260822000001_agenda_frd.sql. Checked
// here too so an over-long description is a 400 that says so, rather than a 500
// from a constraint violation.
const MAX_DESCRIPTION = 650;
const MAX_NAME = 200;
const MAX_TAGS = 2;

/** What public.agenda's three config columns point at. */
const QUEST = "event-quest";
const EVENT_DAY = "event-day";
const STAGE = "stage-type";
const USER_TYPE = "user_type";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keys that mean "replace this event's tags / audiences". */
const TAG_KEYS = ["tags", "primary_tag"];
const AUDIENCE_KEYS = ["user_types", "audiences"];

type Row = Record<string, unknown>;
type Named = { id: number; name: string };

/** public.configs and public.guilds, whole. A dozen-odd rows each. */
type Vocabulary = {
  configs: { id: number; name: string; type: string }[];
  guilds: Named[];
};

async function loadVocabulary(): Promise<Vocabulary> {
  const service = serviceClient();
  const [configs, guilds] = await Promise.all([
    service.from("configs").select("id, name, type"),
    service.from("guilds").select("id, name"),
  ]);
  if (configs.error) throw configs.error;
  if (guilds.error) throw guilds.error;

  return {
    configs: (configs.data ?? []) as Vocabulary["configs"],
    guilds: (guilds.data ?? []) as Named[],
  };
}

/** The names of one config type, for an error message that can be acted on. */
function optionsFor(vocab: Vocabulary, type: string): string {
  const names = vocab.configs.filter((row) => row.type === type).map((row) => row.name);
  return names.length ? names.join(", ") : "(none configured)";
}

/**
 * A configs.id from either an id or a name. An id is still checked against the
 * type, because all five config types share one id sequence and pointing an
 * event's stage at 'Day 1' would otherwise be accepted silently.
 */
function resolveConfig(
  vocab: Vocabulary,
  type: string,
  value: unknown,
  field: string,
): { id: number } | { error: string } {
  const asId = integer(value);
  if (asId !== null) {
    const match = vocab.configs.find((row) => row.id === asId);
    if (!match) return { error: `${field}: there is no config with id ${asId}.` };
    if (match.type !== type) {
      return {
        error:
          `${field}: config ${asId} is "${match.name}" of type ${match.type}, not ${type}.`,
      };
    }
    return { id: asId };
  }

  const name = text(value);
  if (!name) {
    return {
      error: `${field} must be a configs.id or a name. One of: ${
        optionsFor(vocab, type)
      }.`,
    };
  }
  const match = vocab.configs.find(
    (row) => row.type === type && row.name.toLowerCase() === name.toLowerCase(),
  );
  if (!match) {
    return {
      error: `${field}: "${name}" does not match any ${type}. One of: ${
        optionsFor(vocab, type)
      }.`,
    };
  }
  return { id: match.id };
}

/** A guilds.id from either an id or a name — the tag vocabulary. */
function resolveGuild(
  vocab: Vocabulary,
  value: unknown,
  field: string,
): { id: number } | { error: string } {
  const asId = integer(value);
  if (asId !== null) {
    const match = vocab.guilds.find((guild) => guild.id === asId);
    return match
      ? { id: asId }
      : { error: `${field}: there is no guild with id ${asId}.` };
  }

  const name = text(value);
  if (!name) return { error: `${field} must be a guilds.id or a guild name.` };
  const match = vocab.guilds.find((guild) =>
    guild.name.toLowerCase() === name.toLowerCase()
  );
  return match ? { id: match.id } : { error: `${field}: "${name}" is not a guild.` };
}

/**
 * A timestamptz. Anything Date.parse understands is accepted and normalised to
 * UTC, so "2026-09-15T09:00:00-05:00" and "2026-09-15T14:00:00Z" both land as the
 * same instant — but a bare "2026-09-15 09:00" has no zone and would be read as
 * the server's, so require one.
 */
function readTimestamp(
  value: unknown,
  field: string,
): { value: string } | { error: string } {
  const raw = text(value);
  if (!raw) return { error: `${field} must be an ISO 8601 timestamp.` };
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    return {
      error: `${field}: "${raw}" is not a timestamp. Use e.g. 2026-09-15T15:00:00Z.`,
    };
  }
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    return {
      error: `${field} needs a time zone — end it with Z or an offset like -05:00.`,
    };
  }
  return { value: new Date(parsed).toISOString() };
}

/** One tag: a guild, and whether it is the event's primary one. */
type Tag = { guild_id: number; is_primary: boolean };

/**
 * Reads the tags.
 *
 * `tags` items may be a guilds.id, a guild name, or { guild_id | tag, is_primary }.
 * `primary_tag` names the primary one separately, which is the shape a form with
 * two pickers produces. The first tag is the primary one when nothing says
 * otherwise, so the common single-tag case needs no flag — see
 * agenda_guilds_one_primary and enforce_agenda_tag_limit() in
 * 20260822000001_agenda_frd.sql for the rules this has to satisfy.
 */
function readTags(body: Row, vocab: Vocabulary): { tags: Tag[] } | { error: string } {
  const raw: unknown[] = Array.isArray(body.tags)
    ? [...body.tags]
    : body.tags !== undefined && body.tags !== null
    ? [body.tags]
    : [];

  const tags: Tag[] = [];
  const seen = new Set<number>();

  const add = (guildId: number, isPrimary: boolean) => {
    if (seen.has(guildId)) return;
    seen.add(guildId);
    tags.push({ guild_id: guildId, is_primary: isPrimary });
  };

  // Named primary first, so it stays the primary one whether or not it also
  // appears in `tags`.
  if (body.primary_tag !== undefined && body.primary_tag !== null) {
    const resolved = resolveGuild(vocab, body.primary_tag, "primary_tag");
    if ("error" in resolved) return resolved;
    add(resolved.id, true);
  }

  for (const [index, item] of raw.entries()) {
    const field = `tags[${index}]`;
    const source = item !== null && typeof item === "object" && !Array.isArray(item)
      ? item as Row
      : { tag: item };

    const value = source.guild_id ?? source.tag ?? source.id ?? source.name;
    const resolved = resolveGuild(vocab, value, field);
    if ("error" in resolved) return resolved;

    let isPrimary = false;
    if (source.is_primary !== undefined && source.is_primary !== null) {
      const flag = readBoolean(source.is_primary, `${field}.is_primary`);
      if ("error" in flag) return flag;
      isPrimary = flag.value;
    }
    add(resolved.id, isPrimary);
  }

  if (tags.length > MAX_TAGS) {
    return { error: `At most ${MAX_TAGS} tags per event (one primary, one secondary).` };
  }

  const primaries = tags.filter((tag) => tag.is_primary);
  if (primaries.length > 1) return { error: "Only one tag can be the primary one." };
  // Exactly one primary per event at most, and a lone tag is that one.
  if (primaries.length === 0 && tags.length > 0) tags[0].is_primary = true;

  return { tags };
}

/** Builder / Operator / Explorer, as configs ids of type user_type. */
function readUserTypes(
  body: Row,
  vocab: Vocabulary,
): { ids: number[] } | { error: string } {
  const source = body.user_types ?? body.audiences;
  const raw: unknown[] = Array.isArray(source)
    ? source
    : source !== undefined && source !== null
    ? [source]
    : [];

  const ids: number[] = [];
  for (const [index, item] of raw.entries()) {
    const resolved = resolveConfig(vocab, USER_TYPE, item, `user_types[${index}]`);
    if ("error" in resolved) return resolved;
    if (!ids.includes(resolved.id)) ids.push(resolved.id);
  }
  return { ids };
}

const OPTIONAL_TEXT = [
  "speaker_name",
  "speaker_title",
  "speaker_company",
  "location",
  "status",
];

/*
 * The event's own columns.
 *
 * On create only `name` is required: the FRD's agenda is authored in passes (times
 * and stages are assigned after the sessions exist), so an event with nothing but
 * a name is a legitimate draft. On update every key is optional and only the ones
 * present are written — absent keys are left alone rather than reset, and an
 * explicit null clears an optional field.
 */
function readColumns(
  body: Row,
  vocab: Vocabulary,
  requireName: boolean,
): { row: Row } | { error: string } {
  const row: Row = {};

  if (requireName || "name" in body) {
    const name = text(body.name);
    if (!name) {
      return {
        error: requireName ? '"name" is required.' : '"name" must be a non-empty string.',
      };
    }
    if (name.length > MAX_NAME) {
      return { error: `"name" must be ${MAX_NAME} characters or fewer.` };
    }
    row.name = name;
  }

  if ("description" in body) {
    if (body.description === null) {
      row.description = null;
    } else if (typeof body.description !== "string") {
      return { error: '"description" must be a string, or null.' };
    } else {
      const description = body.description.trim();
      if (description.length > MAX_DESCRIPTION) {
        return {
          error:
            `"description" must be ${MAX_DESCRIPTION} characters or fewer (got ${description.length}).`,
        };
      }
      row.description = description || null;
    }
  }

  for (const key of OPTIONAL_TEXT) {
    if (!(key in body)) continue;
    if (body[key] === null) {
      // status is NOT NULL with a default, so clearing it means the default.
      if (key === "status") continue;
      row[key] = null;
      continue;
    }
    const value = text(body[key]);
    if (!value) return { error: `"${key}" must be a non-empty string, or null.` };
    row[key] = value;
  }

  if ("day" in body) {
    if (body.day === null) {
      row.day = null;
    } else {
      const day = text(body.day);
      if (!day || !DATE_RE.test(day)) {
        return { error: '"day" must be a date in YYYY-MM-DD form, or null.' };
      }
      row.day = day;
    }
  }

  for (const key of ["start_time", "end_time"] as const) {
    if (!(key in body)) continue;
    if (body[key] === null) {
      row[key] = null;
      continue;
    }
    const parsed = readTimestamp(body[key], `"${key}"`);
    if ("error" in parsed) return parsed;
    row[key] = parsed.value;
  }

  const configFields: [string, string, string][] = [
    ["quest", QUEST, "event_quest_config_id"],
    ["event_day", EVENT_DAY, "event_day_config_id"],
    ["stage", STAGE, "stage_config_id"],
  ];
  for (const [alias, type, column] of configFields) {
    // The column name is canonical; the short alias is the convenient one.
    const key = column in body ? column : alias in body ? alias : null;
    if (key === null) continue;
    if (body[key] === null) {
      row[column] = null;
      continue;
    }
    const resolved = resolveConfig(vocab, type, body[key], `"${key}"`);
    if ("error" in resolved) return resolved;
    row[column] = resolved.id;
  }

  for (const [key, min] of [["xp_value", 0], ["sort_order", 0]] as const) {
    if (!(key in body) || body[key] === null) continue;
    const parsed = readInt(body[key], `"${key}"`, min);
    if ("error" in parsed) return parsed;
    row[key] = parsed.value;
  }

  if ("capacity" in body) {
    if (body.capacity === null) {
      // Null is "no limit", which is what an invite-only event without a room cap
      // means.
      row.capacity = null;
    } else {
      const parsed = readInt(body.capacity, '"capacity"', 1);
      if ("error" in parsed) return parsed;
      row.capacity = parsed.value;
    }
  }

  for (const key of ["is_sponsored", "is_invite_only"] as const) {
    if (!(key in body) || body[key] === null) continue;
    const parsed = readBoolean(body[key], `"${key}"`);
    if ("error" in parsed) return parsed;
    row[key] = parsed.value;
  }

  return { row };
}

/**
 * end_time after start_time, against the event as it will be once `row` is
 * applied: an update that moves only the start still has to make sense with the
 * end already stored. Either side missing is a legitimate draft, so it is only
 * checked when both are known.
 */
function timesAgree(row: Row, existing: Row | null): string | null {
  const start = "start_time" in row ? row.start_time : existing?.start_time ?? null;
  const end = "end_time" in row ? row.end_time : existing?.end_time ?? null;
  if (typeof start !== "string" || typeof end !== "string") return null;
  return Date.parse(end) <= Date.parse(start)
    ? '"end_time" must be after "start_time".'
    : null;
}

/** The columns the response echoes back — the same set user/agenda.ts reads. */
const EVENT_SELECT = `
  id, name, description, day, start_time, end_time,
  speaker_name, speaker_title, speaker_company,
  location, xp_value, is_sponsored, is_invite_only, capacity,
  sort_order, status,
  event_quest_config_id, event_day_config_id, stage_config_id,
  created_at
`;

/**
 * The event as it now stands, with its config, tag and audience names resolved —
 * read back from the join tables rather than echoed from the request, so the
 * response is what was actually stored.
 */
async function describe(row: Row, vocab: Vocabulary, message: string): Promise<Response> {
  const agendaId = row.id as string;
  const service = serviceClient();

  const [tagLinks, audienceLinks] = await Promise.all([
    service.from("agenda_guilds").select("guild_id, is_primary").eq(
      "agenda_id",
      agendaId,
    ),
    service.from("agenda_user_types").select("user_type_config_id").eq(
      "agenda_id",
      agendaId,
    ),
  ]);
  if (tagLinks.error) logDbFailure("agenda tags read-back", tagLinks.error);
  if (audienceLinks.error) {
    logDbFailure("agenda user types read-back", audienceLinks.error);
  }

  // { id, name } only — `configs.type` is an implementation detail of the lookup,
  // and this is the shape user/agenda.ts returns for the same three fields.
  const named = (id: unknown): Named | null => {
    const match = vocab.configs.find((config) => config.id === id);
    return match ? { id: match.id, name: match.name } : null;
  };

  // Primary first, matching the order user/agenda.ts returns tags in.
  const tags = (tagLinks.data ?? [])
    .map((link) => ({
      ...vocab.guilds.find((guild) => guild.id === link.guild_id),
      is_primary: link.is_primary === true,
    }))
    .sort((a, b) => (a.is_primary === b.is_primary ? 0 : a.is_primary ? -1 : 1));

  return ok(message, {
    ...row,
    quest: named(row.event_quest_config_id),
    event_day: named(row.event_day_config_id),
    stage: named(row.stage_config_id),
    tags,
    primary_tag: tags.find((tag) => tag.is_primary) ?? null,
    user_types: (audienceLinks.data ?? [])
      .map((link) => named(link.user_type_config_id))
      .filter(Boolean),
  });
}

/**
 * Writes an event's tags and audiences, replacing whatever it had.
 *
 * Returns an error message when either write fails. There is no transaction across
 * PostgREST calls, so the previous rows are put back on failure: an event that
 * silently lost its tags would go unnoticed until someone filtered the Agenda
 * screen by that tag.
 */
async function writeLinks(
  agendaId: string,
  tags: Tag[] | null,
  userTypeIds: number[] | null,
): Promise<string | null> {
  const service = serviceClient();

  if (tags !== null) {
    const previous = await service.from("agenda_guilds")
      .select("guild_id, is_primary").eq("agenda_id", agendaId);
    if (previous.error) {
      logDbFailure("agenda tags read", previous.error);
      return "The event's tags could not be read.";
    }

    const cleared = await service.from("agenda_guilds").delete().eq(
      "agenda_id",
      agendaId,
    );
    if (cleared.error) {
      logDbFailure("agenda tags clear", cleared.error);
      return "The event's existing tags could not be replaced.";
    }

    if (tags.length > 0) {
      const { error } = await service.from("agenda_guilds")
        .insert(tags.map((tag) => ({ agenda_id: agendaId, ...tag })));
      if (error) {
        logDbFailure("agenda tags insert", error);
        // Put back what was there. If this fails too the event is left untagged,
        // which the log line above and this one together make findable.
        if ((previous.data ?? []).length > 0) {
          const restored = await service.from("agenda_guilds")
            .insert(
              (previous.data ?? []).map((link) => ({ agenda_id: agendaId, ...link })),
            );
          if (restored.error) {
            logDbFailure(`agenda tags restore for ${agendaId}`, restored.error);
          }
        }
        return "The event's tags could not be saved.";
      }
    }
  }

  if (userTypeIds !== null) {
    const previous = await service.from("agenda_user_types")
      .select("user_type_config_id").eq("agenda_id", agendaId);
    if (previous.error) {
      logDbFailure("agenda user types read", previous.error);
      return "The event's audiences could not be read.";
    }

    const cleared = await service.from("agenda_user_types").delete().eq(
      "agenda_id",
      agendaId,
    );
    if (cleared.error) {
      logDbFailure("agenda user types clear", cleared.error);
      return "The event's existing audiences could not be replaced.";
    }

    if (userTypeIds.length > 0) {
      const { error } = await service.from("agenda_user_types")
        .insert(
          userTypeIds.map((id) => ({ agenda_id: agendaId, user_type_config_id: id })),
        );
      if (error) {
        logDbFailure("agenda user types insert", error);
        if ((previous.data ?? []).length > 0) {
          const restored = await service.from("agenda_user_types")
            .insert(
              (previous.data ?? []).map((link) => ({ agenda_id: agendaId, ...link })),
            );
          if (restored.error) {
            logDbFailure(`agenda user types restore for ${agendaId}`, restored.error);
          }
        }
        return "The event's audiences could not be saved.";
      }
    }
  }

  return null;
}

/**
 * POST admin/agenda/create
 *
 * The event row, then its tags, then its audiences. If either of the latter two
 * fails the event row is deleted again rather than left half-created — both join
 * tables cascade on delete, so that also takes any rows that did land.
 */
export async function createEvent(body: Row): Promise<Response> {
  const vocab = await loadVocabulary();

  const columns = readColumns(body, vocab, true);
  if ("error" in columns) return fail(columns.error, 400);

  const clash = timesAgree(columns.row, null);
  if (clash) return fail(clash, 400);

  const tags = readTags(body, vocab);
  if ("error" in tags) return fail(tags.error, 400);

  const userTypes = readUserTypes(body, vocab);
  if ("error" in userTypes) return fail(userTypes.error, 400);

  const service = serviceClient();
  const { data: created, error } = await service
    .from("agenda")
    .insert(columns.row)
    .select(EVENT_SELECT)
    .single();

  if (error || !created) {
    logDbFailure("agenda insert", error);
    return fail("Something went wrong. Please try again.", 500);
  }

  const agendaId = created.id as string;
  const linkError = await writeLinks(agendaId, tags.tags, userTypes.ids);
  if (linkError) {
    const { error: cleanupError } = await service.from("agenda").delete().eq(
      "id",
      agendaId,
    );
    if (cleanupError) {
      logDbFailure(`agenda rollback for ${agendaId}`, cleanupError);
      return fail(
        `${linkError} The half-created event ${agendaId} could not be removed.`,
        500,
      );
    }
    return fail(`${linkError} The event was not created.`, 400);
  }

  return await describe(created, vocab, `Created "${created.name}".`);
}

/**
 * POST admin/agenda/update
 *
 * A patch: only the keys present are written, so editing one field does not need
 * the whole event. `tags` / `primary_tag` and `user_types` each replace that whole
 * set when present — send `"tags": []` to remove them — and are left untouched
 * when absent.
 */
export async function updateEvent(body: Row): Promise<Response> {
  const agendaId = text(body.id) ?? text(body.agenda_id);
  if (!agendaId || !UUID_RE.test(agendaId)) {
    return fail('"id" must be the event\'s uuid.', 400);
  }

  const vocab = await loadVocabulary();

  const columns = readColumns(body, vocab, false);
  if ("error" in columns) return fail(columns.error, 400);

  const touchesTags = TAG_KEYS.some((key) => key in body);
  const touchesAudiences = AUDIENCE_KEYS.some((key) => key in body);

  const tags = touchesTags ? readTags(body, vocab) : null;
  if (tags && "error" in tags) return fail(tags.error, 400);

  const userTypes = touchesAudiences ? readUserTypes(body, vocab) : null;
  if (userTypes && "error" in userTypes) return fail(userTypes.error, 400);

  if (Object.keys(columns.row).length === 0 && !touchesTags && !touchesAudiences) {
    return fail("Nothing to change — send at least one field to update.", 400);
  }

  const service = serviceClient();
  const existing = await service.from("agenda").select(EVENT_SELECT).eq("id", agendaId)
    .maybeSingle();
  if (existing.error) {
    logDbFailure("agenda read for update", existing.error);
    return fail("Something went wrong. Please try again.", 500);
  }
  if (!existing.data) return fail("That event could not be found.", 404);

  const clash = timesAgree(columns.row, existing.data);
  if (clash) return fail(clash, 400);

  let current: Row = existing.data;
  if (Object.keys(columns.row).length > 0) {
    const { data, error } = await service
      .from("agenda")
      .update(columns.row)
      .eq("id", agendaId)
      .select(EVENT_SELECT)
      .single();
    if (error || !data) {
      logDbFailure("agenda update", error);
      return fail("Something went wrong. Please try again.", 500);
    }
    current = data;
  }

  const linkError = await writeLinks(
    agendaId,
    tags && "tags" in tags ? tags.tags : null,
    userTypes && "ids" in userTypes ? userTypes.ids : null,
  );
  // The column update already succeeded, so this is a partial success: say which
  // half failed rather than rolling the whole edit back.
  if (linkError) return fail(`${linkError} The event's other fields were saved.`, 400);

  return await describe(current, vocab, `Updated "${current.name}".`);
}
