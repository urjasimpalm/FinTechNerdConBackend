// Managing speakers for agenda events
//
//   GET  admin/speakers           → list all speakers
//   POST admin/speakers           → create a speaker
//   PUT  admin/speakers/{id}      → update a speaker
//   DELETE admin/speakers/{id}    → delete a speaker
//
// Speakers are used when creating or editing agenda events.
import { fail, ok, text } from "../_shared/http.ts";
import { logDbFailure, serviceClient } from "../_shared/supabase.ts";

type Speaker = {
  id?: string;
  name: string;
  title?: string | null;
  company?: string | null;
  bio?: string | null;
  linkedin?: string | null;
  status: string;
  role: string;
};

// Generate a unique speaker ID
function generateSpeakerId(): string {
  return `speaker_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Validate speaker data
function validateSpeaker(
  speaker: Record<string, unknown>,
): { speaker?: Speaker; error?: string } {
  const name = text(speaker.name);
  if (!name || name.trim() === "") {
    return { error: '"name" is required and must not be empty.' };
  }

  const title = speaker.title === null ? null : text(speaker.title) || null;
  const company = speaker.company === null ? null : text(speaker.company) || null;
  const bio = speaker.bio === null ? null : text(speaker.bio) || null;
  const linkedin = speaker.linkedin === null ? null : text(speaker.linkedin) || null;

  const status = speaker.status ? text(speaker.status) : undefined;
  const role = speaker.role ? text(speaker.role) : undefined;

  return {
    speaker: {
      id: speaker.id ? text(speaker.id) ?? undefined : undefined,
      name: name.trim(),
      title,
      company,
      bio,
      linkedin,
      status: status ?? "confirmed",
      role: role ?? "speaker",
    },
  };
}

// GET admin/speakers - List all speakers
export async function listSpeakers(): Promise<Response> {
  try {
    const service = serviceClient();
    const { data, error } = await service
      .from("speakers")
      .select("id, name, title, company, bio, linkedin, status, role, created_at, updated_at")
      .order("created_at", { ascending: false });

    if (error) throw error;

    return ok("Speakers loaded.", { speakers: data ?? [] });
  } catch (err) {
    console.error("speakers list failed", err);
    return fail("Something went wrong. Please try again.", 500);
  }
}

// POST admin/speakers - Create a speaker
export async function createSpeaker(body: Record<string, unknown>): Promise<Response> {
  const validated = validateSpeaker(body);
  if (validated.error) return fail(validated.error, 400);
  if (!validated.speaker) return fail("Invalid speaker data.", 400);

  const speaker = validated.speaker;
  const id = speaker.id || generateSpeakerId();

  try {
    const service = serviceClient();
    const { data, error } = await service
      .from("speakers")
      .insert({
        id,
        name: speaker.name,
        title: speaker.title,
        company: speaker.company,
        bio: speaker.bio,
        linkedin: speaker.linkedin,
        status: speaker.status,
        role: speaker.role,
      })
      .select("id, name, title, company, bio, linkedin, status, role, created_at, updated_at")
      .single();

    if (error) {
      logDbFailure("speaker create", error);
      if (error.code === "23505") {
        return fail(`Speaker with id "${id}" already exists.`, 409);
      }
      return fail("Something went wrong. Please try again.", 500);
    }

    return ok(`Created speaker "${speaker.name}".`, { speaker: data });
  } catch (err) {
    console.error("speaker create failed", err);
    return fail("Something went wrong. Please try again.", 500);
  }
}

// PUT admin/speakers/{id} - Update a speaker
export async function updateSpeaker(
  speakerId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  if (!speakerId || speakerId.trim() === "") {
    return fail('"id" must be provided in the path.', 400);
  }

  const validated = validateSpeaker(body);
  if (validated.error) return fail(validated.error, 400);
  if (!validated.speaker) return fail("Invalid speaker data.", 400);

  const speaker = validated.speaker;

  try {
    const service = serviceClient();
    const { data, error } = await service
      .from("speakers")
      .update({
        name: speaker.name,
        title: speaker.title,
        company: speaker.company,
        bio: speaker.bio,
        linkedin: speaker.linkedin,
        status: speaker.status,
        role: speaker.role,
        updated_at: new Date().toISOString(),
      })
      .eq("id", speakerId)
      .select("id, name, title, company, bio, linkedin, status, role, created_at, updated_at")
      .single();

    if (error) {
      logDbFailure("speaker update", error);
      return fail("Something went wrong. Please try again.", 500);
    }

    if (!data) {
      return fail(`Speaker with id "${speakerId}" not found.`, 404);
    }

    return ok(`Updated speaker "${speaker.name}".`, { speaker: data });
  } catch (err) {
    console.error("speaker update failed", err);
    return fail("Something went wrong. Please try again.", 500);
  }
}

// DELETE admin/speakers/{id} - Delete a speaker
export async function deleteSpeaker(speakerId: string): Promise<Response> {
  if (!speakerId || speakerId.trim() === "") {
    return fail('"id" must be provided in the path.', 400);
  }

  try {
    const service = serviceClient();
    const { data, error } = await service
      .from("speakers")
      .delete()
      .eq("id", speakerId)
      .select("id, name")
      .single();

    if (error) {
      logDbFailure("speaker delete", error);
      return fail("Something went wrong. Please try again.", 500);
    }

    if (!data) {
      return fail(`Speaker with id "${speakerId}" not found.`, 404);
    }

    return ok(`Deleted speaker "${data.name}".`, { speaker_id: speakerId });
  } catch (err) {
    console.error("speaker delete failed", err);
    return fail("Something went wrong. Please try again.", 500);
  }
}
