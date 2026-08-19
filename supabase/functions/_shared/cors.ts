// The mobile/web clients call these functions cross-origin, so every response
// (including errors and the preflight) has to carry CORS headers.
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  // admin/user/remove is a DELETE and user/profile is a GET/PUT, so the
  // preflight has to advertise more than POST.
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};
