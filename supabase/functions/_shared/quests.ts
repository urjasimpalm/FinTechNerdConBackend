/*
 * Which section of the Agenda an event belongs to: Main / Side / Bonus Quests.
 *
 * Matched on the public.configs *name* rather than its id: configs rows are handed
 * ids by one shared sequence, so the same section has different ids in different
 * environments. The prefix match is the same one the database does in
 * public.award_agenda_mission() (`quest like 'bonus%'`, 20260822000002), which
 * decides whether saving an event earns "Add a session" or "Book Your First
 * Quest".
 *
 * Used by admin/stats.ts only. user/agenda.ts keeps its own identical copy on
 * purpose — that module was left untouched by request, having just been stabilised
 * after a run of 400s, and a behaviour-neutral refactor was not worth reopening
 * it. So this rule now lives in three places: here, there, and the trigger. If one
 * changes, change all three.
 */
export type QuestSection = "main" | "side" | "bonus";

export function questSection(name: unknown): QuestSection | null {
  const value = typeof name === "string" ? name.toLowerCase() : "";
  if (value.startsWith("main")) return "main";
  if (value.startsWith("side")) return "side";
  if (value.startsWith("bonus")) return "bonus";
  return null;
}

/** The values a `?quest=` filter accepts. */
export const QUEST_SECTIONS: QuestSection[] = ["main", "side", "bonus"];

export function isQuestSection(value: string): value is QuestSection {
  return (QUEST_SECTIONS as string[]).includes(value);
}
