/*
 * Add a sign-up link to agenda events.
 *
 * signup_url is where a person goes to register for the session. Nullable: most
 * events have no external sign-up. It is returned by user/agenda.ts and
 * admin/agenda.ts, settable through admin/agenda/create and admin/agenda/update,
 * and copied across by admin/agenda/migrate-from-source.
 */

alter table public.agenda
  add column if not exists signup_url text null;

comment on column public.agenda.signup_url is
  'Optional external sign-up link for the event. Null when the event has none.';
