import { errorMessage, getPlayback, PlaybackError } from "./api/playback.js";

const NO_STORE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store, max-age=0",
  "CDN-Cache-Control": "no-store"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/playback") return playbackResponse(url);

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Static assets are not configured. Deploy with --assets=public.", {
      status: 500,
      headers: { "Cache-Control": "no-store" }
    });
  }
};

async function playbackResponse(url) {
  try {
    const data = await getPlayback(url.searchParams.get("url") || url.searchParams.get("map") || url.searchParams.get("id") || "");
    return json(data, 200);
  } catch (error) {
    const isPlayback = error instanceof PlaybackError;
    const resPayload = {
      error: errorMessage(error),
      code: isPlayback ? error.code : "INTERNAL_ERROR"
    };
    if (isPlayback && error.mapId) {
      resPayload.mapId = error.mapId;
    }
    return json(resPayload, isPlayback ? error.status : 500);
  }
}

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: NO_STORE_HEADERS });
}
