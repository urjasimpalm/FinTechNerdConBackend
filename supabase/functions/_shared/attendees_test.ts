// Run with: deno test supabase/functions/_shared/attendees_test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { attendeeWindow, shapeAttendee } from "./attendees.ts";
import { shapeProfile } from "./profile.ts";

const page = (offset: number, perPage: number) => ({
  page: Math.floor(offset / perPage) + 1,
  perPage,
  offset,
});

Deno.test("a page entirely within the registered people takes no attendees", () => {
  assertEquals(attendeeWindow(page(0, 20), 50, 20), { offset: 0, limit: 0 });
});

Deno.test("a page straddling the boundary fills the rest from the attendees", () => {
  assertEquals(attendeeWindow(page(40, 20), 50, 10), { offset: 0, limit: 10 });
});

Deno.test("a page past the registered people starts partway into the attendees", () => {
  assertEquals(attendeeWindow(page(60, 20), 50, 0), { offset: 10, limit: 20 });
});

Deno.test("with no registered people, the attendees are paged on their own", () => {
  assertEquals(attendeeWindow(page(20, 20), 0, 0), { offset: 20, limit: 20 });
});

Deno.test("an attendee card has the same keys, in the same order, as a registered card", () => {
  const registered = shapeProfile({
    id: "e1607bb0-1404-46fc-ade9-773c58282979",
    first_name: "A",
    last_name: "BC",
    nerd_number: "00014",
    company_name: "Simpalm",
    job_title: "BA",
    profile_image: null,
    user_type_config_id: 3,
    user_type: { id: 3, name: "Explorer", description: "x" },
    user_guilds: [],
  });
  const registeredCard = {
    ...registered,
    connection: { status: "none", request_id: null },
    is_connected: false,
  };

  const attendee = shapeAttendee({
    id: "0d6d5a4e-0000-4000-8000-000000000001",
    first_name: "Dave",
    last_name: "Birch",
    company_name: "15Mb",
    job_title: "Director",
  });

  assertEquals(Object.keys(attendee), Object.keys(registeredCard));
});

Deno.test("an attendee with no company or title gets nulls, and no user type, guilds or connection", () => {
  const attendee = shapeAttendee({
    id: "0d6d5a4e-0000-4000-8000-000000000002",
    first_name: "Martha",
    last_name: "Cummings",
    company_name: undefined,
    job_title: null,
  });

  assertEquals(attendee, {
    id: "0d6d5a4e-0000-4000-8000-000000000002",
    first_name: "Martha",
    last_name: "Cummings",
    nerd_number: null,
    company_name: null,
    job_title: null,
    profile_image: null,
    user_type_config_id: null,
    user_type: null,
    guilds: [],
    connection: { status: "none", request_id: null },
    is_connected: false,
  });
});
