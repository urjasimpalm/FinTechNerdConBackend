// The mobile/web clients call these functions cross-origin, so every response
// (including errors and the preflight) has to carry CORS headers.
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
