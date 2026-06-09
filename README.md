# CalTopo Track Playback

A small web tool for replaying timestamped CalTopo live tracks from a shared map URL.

Paste a CalTopo map link, load the tracks, then use the timeline controls to replay event movement. The app supports trail playback, position-only playback, stale-track fadeout, and per-track visibility toggles.

## Deploying on Vercel

This folder is a standalone Vercel app:

```sh
npm install
npm run build
vercel deploy --prod
```

The serverless API fetches public or share-link-accessible CalTopo map data from the server side so the browser does not need CalTopo API access directly.
