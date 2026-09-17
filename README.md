# CalTopo Playback Tool

Replay timestamped CalTopo tracks and event markers from a public or share-link-accessible map.

The hosted tool is available at [caltopo-track-playback.vercel.app](https://caltopo-track-playback.vercel.app/).

This is an independent project. It is not affiliated with, endorsed by, or sponsored by CalTopo.

## Public Demo

[**Try the SAR Academy multi-team playback demo**](https://caltopo-track-playback.vercel.app/?map=https%3A%2F%2Fcaltopo.com%2Fm%2F04GP2VD)

The public [SAR Academy 2510-2 map](https://caltopo.com/m/04GP2VD) provides a complex search-and-rescue training example: 23 timestamped tracks, 23,313 recorded points, and 55 markers across several dates. No CalTopo login is required.

The **October 25, 2025** session is the best showcase. It contains **20 tracks and 16,186 points**, with **16 tracks recording simultaneously** at its busiest moment. Tracks labeled T8, T9, T10, and T11 overlap around checkpoints and a command post. A **Flat tire** hazard appears during the replay at its recorded creation time.

1. Keep **Range** on **10/25/2025 (20 tracks)**, which the player selects automatically for this map.
2. Set **Speed** to **600x** and **Stale** to **Never**.
3. Drag the timeline to the main overlapping activity, **20:35–22:45 UTC** on October 25 (**1:35–3:45 PM Pacific**). The player displays times in your browser's local timezone.
4. Select **Play**, switch **View** between **Trails** and **Positions**, and toggle individual tracks or marker groups to inspect the team movements.

Map credit: the original public **SAR Academy 2510-2** map and its contributors. The demo reads that map live; it does not copy the dataset into this repository. Counts reflect the map checked on September 16, 2026. Markers added after the selected session remain hidden during its historical replay. This project is not affiliated with the training organizers.

## What It Does

- Loads CalTopo map links, share links, and raw map IDs.
- Replays timestamped `Shape`, `AppTrack`, `FieldTrack`, and `LiveTrack` line data.
- Shows CalTopo markers such as hazards, rest stops, checkpoints, services, and HQ.
- Preserves CalTopo marker images, colors, fill, rotation, sizes, and anchor points, including custom icons.
- Starts each replay range at its first recorded object instead of an empty midnight timeline.
- Replays marker additions using each marker's CalTopo created time.
- Supports trail playback, position-only playback, stale-track fadeout, range selection, and per-track visibility.
- Keeps marker labels hover-only by default to reduce clutter.
- Uses a collapsed bottom list on mobile so the map remains the primary view.

## Quick Start

1. Open [caltopo-track-playback.vercel.app](https://caltopo-track-playback.vercel.app/).
2. Paste a CalTopo map URL, share URL, or map ID.
3. Select **Load**.
4. Use **Play**, the timeline slider, speed, stale timeout, view mode, and range controls to review the event.
5. Toggle tracks or marker groups in the side panel. On phones, tap **List** to open the drawer.

You can share a preloaded playback URL by adding the map as a query parameter:

```text
https://caltopo-track-playback.vercel.app/?map=https%3A%2F%2Fcaltopo.com%2Fm%2FYOURMAPID
```

## Map Requirements

- The CalTopo map must be public or accessible through the provided share link.
- Tracks must contain timestamped line coordinates.
- Markers are optional. When present, they are grouped from CalTopo folders and marker metadata.
- The tool does not need or store CalTopo account credentials.

## Marker Categories

Marker groups are inferred from folder names, marker names, descriptions, and symbols:

- Hazards
- Rest Stops
- Checkpoints
- Services
- HQ
- Other Markers

Markers created before the replay window are visible at the start. Markers created during the event appear when playback reaches their CalTopo created time.

## Deploying

This repository is a standalone Vercel app. Import `RCGV1/caltopo-track-playback` into Vercel with the Root Directory set to the repository root (leave it blank). `vercel.json` defines the build command, static output, and API timeout. The hosted project is connected to this repository: pushes to `main` automatically deploy to production. Vercel GitHub access is limited to this repository.

To deploy from a local checkout:

```sh
npm run build
vercel deploy --prod
```

The serverless API fetches CalTopo map data from the server side. This avoids browser CORS limitations when loading arbitrary CalTopo maps. Playback responses use `Cache-Control: no-store`, so map data is not cached by the tool or its CDN.

## Cloudflare Worker Deployment

`worker.js` imports the same API normalizer as Vercel. Deploy it with the static page as Worker Assets:

```sh
npm run build
npx wrangler deploy worker.js --assets=public
```

## Source and License

The playback tool is maintained in [RCGV1/caltopo-track-playback](https://github.com/RCGV1/caltopo-track-playback), independently of the [Glympse desktop bridge](https://github.com/RCGV1/Glympse-CalTopo-Bridge). The original playback commit history is preserved in this repository.

Licensed under GPL-3.0-only; see [LICENSE](LICENSE).
