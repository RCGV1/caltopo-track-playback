# CalTopo Playback Tool

A reusable web tool for replaying timestamped live tracks from any public or share-link-accessible CalTopo map.

Paste a CalTopo map link or map ID, load the tracks, then use the timeline controls to replay event movement. The app supports trail playback, position-only playback, stale-track fadeout, and per-track visibility toggles.

## Deploying on Vercel

This folder is a standalone Vercel app:

```sh
npm install
npm run build
vercel deploy --prod
```

The serverless API fetches CalTopo map data from the server side. This is required because CalTopo does not expose browser CORS headers for direct GitHub Pages-style fetching of arbitrary maps.

## Usage

1. Open the deployed site.
2. Paste a CalTopo map URL, share URL, or map ID.
3. Select Load Tracks.
4. Use Play, the timeline slider, speed, stale timeout, and Trails/Positions view controls to review the event.

Only timestamped line-based live tracks are replayed. The tool does not need or store CalTopo account credentials.
