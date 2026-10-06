/**
 * Migrate agenda from source Supabase project (Fintech NerdCon Agenda Main)
 * to target project (Fintech Nerd Con App Simpalm).
 *
 * POST /functions/v1/admin/agenda/migrate-from-source
 *
 * Requires:
 * - Authenticated user with is_admin = true
 * - Environment variables:
 *   - SOURCE_SUPABASE_URL
 *   - SOURCE_SUPABASE_SERVICE_ROLE_KEY
 *   - TARGET_SUPABASE_URL (SUPABASE_URL)
 *   - TARGET_SUPABASE_SERVICE_ROLE_KEY (SUPABASE_SERVICE_ROLE_KEY)
 */

import { fail, ok } from "../_shared/http.ts";
import { logDbFailure, sourceClient, targetClient } from "../_shared/supabase.ts";

type SourceAgendaRow = {
  session_id: string;
  title: string;
  day: string | null;
  session_date: string | null;
  start_time: string | null;
  end_time: string | null;
  duration_minutes: number | null;
  format: string | null;
  description: string | null;
  stage_name: string | null;
  hall_name: string | null;
  display_group: string | null;
  sort_order: number | null;
  venue: string | null;
  capacity: number | null;
  invite_only: boolean;
  speakers: { name: string; title: string | null; company: string | null; headshot_url: string | null; role: string | null }[] | null;
  topics: unknown;
  xp_value: number | null;
  sponsor_name: string | null;
  sponsored: boolean;
  stage_config_id: number | null;
  event_quest_config_id: number | null;
  event_day_config_id: number | null;
};

type TargetSpeaker = {
  id: string;
  name: string;
  title?: string | null;
  company?: string | null;
  role?: string;
};

type MigrationError = {
  session_id: string;
  title: string;
  error: string;
};

type MigrationResult = {
  success: boolean;
  total: number;
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  failed: number;
  errors: MigrationError[];
};

const MAX_DESCRIPTION = 2000;

/**
 * Generate speaker ID for target speakers table.
 * Format: speaker_${timestamp}_${randomString}
 */
function generateSpeakerId(): string {
  return `speaker_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Find or create speaker in target database.
 * Uses speaker name + company for matching to avoid duplicates.
 */
async function findOrCreateSpeaker(
  targetSvc: ReturnType<typeof targetClient>,
  sourceData: { name: string; title: string | null; company: string | null; headshot_url: string | null; role: string | null },
): Promise<{ id: string; error?: string }> {
  if (!sourceData.name || sourceData.name.trim() === "") {
    return { id: "", error: "Speaker name is required" };
  }

  const speakerName = sourceData.name.trim();
  const speakerCompany = sourceData.company?.trim() || null;

  try {
    // Try to find existing speaker by name (and company if available)
    const { data: existing, error: searchError } = await targetSvc
      .from("speakers")
      .select("id")
      .eq("name", speakerName)
      .maybeSingle();

    if (searchError) {
      logDbFailure("speaker search", searchError);
      return { id: "", error: "Failed to search for existing speaker" };
    }

    if (existing) {
      console.log(`[MIGRATION] Speaker reused: "${speakerName}"`);
      return { id: existing.id };
    }

    // Create new speaker
    const newId = generateSpeakerId();
    const { data: created, error: createError } = await targetSvc
      .from("speakers")
      .insert({
        id: newId,
        name: speakerName,
        title: sourceData.title?.trim() || null,
        company: speakerCompany,
        status: "confirmed",
        role: sourceData.role?.trim() || "speaker",
      })
      .select("id")
      .single();

    if (createError) {
      logDbFailure("speaker create", createError);
      return { id: "", error: "Failed to create speaker" };
    }

    if (!created) {
      return { id: "", error: "Speaker creation returned no data" };
    }

    console.log(`[MIGRATION] Speaker created: "${speakerName}"`);
    return { id: created.id };
  } catch (err) {
    console.error("[MIGRATION] Speaker operation error:", err);
    return { id: "", error: `Unexpected error: ${String(err)}` };
  }
}

/**
 * Migrate speakers from source format to target format with target speaker IDs.
 */
async function migrateSpeakers(
  targetSvc: ReturnType<typeof targetClient>,
  sourceData: SourceAgendaRow,
): Promise<{ speakers: TargetSpeaker[] | null; error?: string }> {
  if (!sourceData.speakers || !Array.isArray(sourceData.speakers) || sourceData.speakers.length === 0) {
    console.log(`[MIGRATION] No speakers in source, returning empty array`);
    return { speakers: [] };
  }

  const speakers: TargetSpeaker[] = [];
  const errors: string[] = [];

  for (const sourceSpeaker of sourceData.speakers) {
    const result = await findOrCreateSpeaker(targetSvc, sourceSpeaker);

    if (result.error) {
      errors.push(`${sourceSpeaker.name}: ${result.error}`);
      continue;
    }

    speakers.push({
      id: result.id,
      role: sourceSpeaker.role || "Speaker",
      name: sourceSpeaker.name,
      title: sourceSpeaker.title || null,
      company: sourceSpeaker.company || null,
    });
  }

  if (speakers.length === 0) {
    // No speakers found in source — return empty array, will be handled by trigger validation
    console.log(`[MIGRATION] No speakers in source for "${sourceData.title}", using empty array`);
    return { speakers: [] };
  }

  if (speakers.length > 4) {
    return { speakers: null, error: "Agenda cannot have more than 4 speakers" };
  }

  return { speakers };
}

/**
 * Validate agenda row before inserting/updating.
 */
function validateAgendaRow(row: Record<string, unknown>): string | null {
  const description = row.description as string | null;
  if (description && description.length > MAX_DESCRIPTION) {
    return `Description exceeds ${MAX_DESCRIPTION} characters (${description.length} chars)`;
  }

  const isSponsored = row.is_sponsored === true;
  const sponsorName = row.sponsor_name as string | null;
  if (isSponsored && (!sponsorName || sponsorName.trim() === "")) {
    return "Sponsored agenda must have a non-empty sponsor_name";
  }

  return null;
}

/**
 * Sync deletions: remove target rows whose source IDs no longer exist.
 */
async function syncDeletions(
  targetSvc: ReturnType<typeof targetClient>,
  sourceSessionIds: Set<string>,
): Promise<{ deleted: number; failed: number; deleteErrors: MigrationError[] }> {
  console.log("[MIGRATION] Starting deletion sync");

  const deleteErrors: MigrationError[] = [];

  try {
    // Fetch all target agenda IDs with source mappings
    const { data: mappings, error: mapFetchError } = await targetSvc
      .from("agenda_source_map")
      .select("source_session_id, target_agenda_id");

    if (mapFetchError) {
      logDbFailure("agenda source map fetch", mapFetchError);
      return { deleted: 0, failed: 1, deleteErrors: [{ session_id: "all", title: "Map fetch", error: "Failed to fetch agenda mappings" }] };
    }

    if (!mappings || mappings.length === 0) {
      console.log("[MIGRATION] No mappings found, nothing to delete");
      return { deleted: 0, failed: 0, deleteErrors: [] };
    }

    // Find target IDs that should be deleted (exist in target but not in source)
    const targetIdsToDelete: Array<{ source_session_id: string; target_agenda_id: string }> = [];

    for (const mapping of mappings) {
      if (!sourceSessionIds.has(mapping.source_session_id)) {
        targetIdsToDelete.push(mapping);
      }
    }

    if (targetIdsToDelete.length === 0) {
      console.log("[MIGRATION] No agenda items to delete");
      return { deleted: 0, failed: 0, deleteErrors: [] };
    }

    console.log(`[MIGRATION] Found ${targetIdsToDelete.length} agenda items to delete`);

    let deletedCount = 0;
    let failedCount = 0;

    // Delete each target agenda item and its mapping
    for (const mapping of targetIdsToDelete) {
      try {
        // Delete from agenda table
        const { error: deleteError } = await targetSvc
          .from("agenda")
          .delete()
          .eq("id", mapping.target_agenda_id);

        if (deleteError) {
          logDbFailure(`agenda delete for id ${mapping.target_agenda_id}`, deleteError);
          deleteErrors.push({
            session_id: mapping.source_session_id,
            title: `Agenda ID: ${mapping.target_agenda_id}`,
            error: `Failed to delete: ${deleteError.message || String(deleteError)}`,
          });
          failedCount++;
          continue;
        }

        // Delete from mapping table
        const { error: mapDeleteError } = await targetSvc
          .from("agenda_source_map")
          .delete()
          .eq("source_session_id", mapping.source_session_id);

        if (mapDeleteError) {
          logDbFailure(`agenda source map delete for ${mapping.source_session_id}`, mapDeleteError);
          deleteErrors.push({
            session_id: mapping.source_session_id,
            title: `Agenda ID: ${mapping.target_agenda_id}`,
            error: `Failed to delete mapping: ${mapDeleteError.message || String(mapDeleteError)}`,
          });
          failedCount++;
          continue;
        }

        deletedCount++;
        console.log(`[MIGRATION] Deleted agenda: ${mapping.source_session_id} (target: ${mapping.target_agenda_id})`);
      } catch (err) {
        console.error("[MIGRATION] Deletion error:", err);
        deleteErrors.push({
          session_id: mapping.source_session_id,
          title: `Agenda ID: ${mapping.target_agenda_id}`,
          error: `Unexpected error: ${String(err)}`,
        });
        failedCount++;
      }
    }

    return { deleted: deletedCount, failed: failedCount, deleteErrors };
  } catch (err) {
    console.error("[MIGRATION] Deletion sync error:", err);
    return { deleted: 0, failed: 1, deleteErrors: [{ session_id: "all", title: "Deletion sync", error: `Unexpected error: ${String(err)}` }] };
  }
}

/**
 * Migrate a single agenda item.
 */
async function migrateAgendaItem(
  sourceSvc: ReturnType<typeof sourceClient>,
  targetSvc: ReturnType<typeof targetClient>,
  sourceRow: SourceAgendaRow,
): Promise<{ id: string; created: boolean; error?: string }> {
  console.log(`[MIGRATION] Processing session: "${sourceRow.title}" (${sourceRow.session_id})`);

  // Check if already migrated
  const { data: existing, error: mapError } = await targetSvc
    .from("agenda_source_map")
    .select("target_agenda_id")
    .eq("source_session_id", sourceRow.session_id)
    .maybeSingle();

  if (mapError) {
    logDbFailure("agenda source map check", mapError);
    return { id: "", created: false, error: "Failed to check migration status" };
  }

  // Validate description length
  const descError = sourceRow.description && sourceRow.description.length > MAX_DESCRIPTION
    ? `Description exceeds ${MAX_DESCRIPTION} characters`
    : null;
  if (descError) {
    return { id: "", created: false, error: descError };
  }

  // Validate sponsor
  if (sourceRow.sponsored && (!sourceRow.sponsor_name || sourceRow.sponsor_name.trim() === "")) {
    return { id: "", created: false, error: "Sponsored session must have sponsor_name" };
  }

  // Migrate speakers
  const speakersResult = await migrateSpeakers(targetSvc, sourceRow);
  if (speakersResult.error) {
    return { id: "", created: false, error: `Speaker migration failed: ${speakersResult.error}` };
  }

  if (!speakersResult.speakers) {
    return { id: "", created: false, error: "No speakers available after migration" };
  }

  // Build agenda row for target
  const agendaRow: Record<string, unknown> = {
    name: sourceRow.title,
    description: sourceRow.description || null,
    day: sourceRow.session_date || null,
    start_time: sourceRow.start_time || null,
    end_time: sourceRow.end_time || null,
    location: sourceRow.stage_name || null,
    event_quest_config_id: sourceRow.event_quest_config_id || null,
    stage_config_id: sourceRow.stage_config_id || null,
    event_day_config_id: sourceRow.event_day_config_id || null,
    is_sponsored: sourceRow.sponsored || false,
    sponsor_name: sourceRow.sponsor_name || null,
    xp_value: sourceRow.xp_value || 0,
    is_invite_only: sourceRow.invite_only || false,
    capacity: sourceRow.capacity || null,
    status: "scheduled",
    speakers: speakersResult.speakers,
    sort_order: sourceRow.sort_order || 0,
  };

  // Validate before insert/update
  const validationError = validateAgendaRow(agendaRow);
  if (validationError) {
    return { id: "", created: false, error: validationError };
  }

  try {
    let result;
    let wasCreated = true;

    if (existing?.target_agenda_id) {
      // Update existing
      const { data, error } = await targetSvc
        .from("agenda")
        .update(agendaRow)
        .eq("id", existing.target_agenda_id)
        .select("id")
        .single();

      if (error) {
        logDbFailure("agenda update", error);
        const errorMsg = (error as any)?.message || String(error) || "Unknown error";
        return { id: "", created: false, error: `Failed to update agenda: ${errorMsg}` };
      }

      result = data;
      wasCreated = false;
      console.log(`[MIGRATION] Agenda updated: "${sourceRow.title}"`);
    } else {
      // Create new
      console.log(`[MIGRATION] Inserting agenda: ${JSON.stringify({ name: agendaRow.name, speakers_count: Array.isArray(agendaRow.speakers) ? agendaRow.speakers.length : 0, event_quest_config_id: agendaRow.event_quest_config_id, stage_config_id: agendaRow.stage_config_id, event_day_config_id: agendaRow.event_day_config_id })}`);
      const { data, error } = await targetSvc
        .from("agenda")
        .insert(agendaRow)
        .select("id")
        .single();

      if (error) {
        logDbFailure("agenda insert", error);
        const errorMsg = (error as any)?.message || String(error) || "Unknown error";
        console.error(`[MIGRATION] Insert failed for "${sourceRow.title}": ${errorMsg}`);
        return { id: "", created: false, error: `Failed to create agenda: ${errorMsg}` };
      }

      result = data;
      console.log(`[MIGRATION] Agenda created: "${sourceRow.title}"`);
    }

    if (!result?.id) {
      return { id: "", created: false, error: "No agenda ID returned" };
    }

    // Record mapping
    if (wasCreated || !existing) {
      const { error: mapInsertError } = await targetSvc
        .from("agenda_source_map")
        .upsert(
          { source_session_id: sourceRow.session_id, target_agenda_id: result.id },
          { onConflict: "source_session_id" },
        );

      if (mapInsertError) {
        logDbFailure("agenda source map insert", mapInsertError);
        return { id: result.id, created: wasCreated, error: "Agenda created but mapping failed" };
      }
    }

    return { id: result.id, created: wasCreated };
  } catch (err) {
    console.error("[MIGRATION] Agenda operation error:", err);
    return { id: "", created: false, error: `Unexpected error: ${String(err)}` };
  }
}

/**
 * Main migration handler.
 */
export async function migrateAgendaFromSource(): Promise<Response> {
  console.log("[MIGRATION] Started");

  const source = sourceClient();
  const target = targetClient();

  try {
    // Fetch source agenda
    console.log("[MIGRATION] Fetching source agenda");
    const { data: sourceRows, error: fetchError } = await source
      .from("public_agenda")
      .select("*");

    if (fetchError) {
      logDbFailure("source agenda fetch", fetchError);
      return fail("Failed to fetch source agenda data", 500);
    }

    const rows = (sourceRows ?? []) as SourceAgendaRow[];
    console.log(`[MIGRATION] Source records found: ${rows.length}`);

    // Track source session IDs for deletion sync
    const sourceSessionIds = new Set<string>();

    // Migrate each row
    const result: MigrationResult = {
      success: true,
      total: rows.length,
      created: 0,
      updated: 0,
      deleted: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    };

    for (const sourceRow of rows) {
      sourceSessionIds.add(sourceRow.session_id);
      const migrationResult = await migrateAgendaItem(source, target, sourceRow);

      if (migrationResult.error) {
        result.failed++;
        result.success = false;
        result.errors.push({
          session_id: sourceRow.session_id,
          title: sourceRow.title,
          error: migrationResult.error,
        });
        console.log(`[MIGRATION] Failed: "${sourceRow.title}" - ${migrationResult.error}`);
      } else if (migrationResult.created) {
        result.created++;
        console.log(`[MIGRATION] Created agenda for: "${sourceRow.title}"`);
      } else {
        result.updated++;
        console.log(`[MIGRATION] Updated agenda for: "${sourceRow.title}"`);
      }
    }

    // Sync deletions: remove target rows that no longer exist in source
    console.log("[MIGRATION] Starting deletion synchronization");
    const deleteResult = await syncDeletions(target, sourceSessionIds);
    result.deleted = deleteResult.deleted;
    if (deleteResult.failed > 0) {
      result.success = false;
      result.errors.push(...deleteResult.deleteErrors);
    }

    console.log("[MIGRATION] Completed");
    console.log(
      `[MIGRATION] Summary: ${result.created} created, ${result.updated} updated, ${result.deleted} deleted, ${result.failed} failed out of ${result.total}`,
    );

    return ok("Migration completed", result);
  } catch (err) {
    console.error("[MIGRATION] Unexpected error:", err);
    return fail(`Migration failed: ${String(err)}`, 500);
  }
}
