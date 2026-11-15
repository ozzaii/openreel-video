# BRAVOH: the artist in OpenReel's own editor

BRAVOH opens a conversation's video in this editor at full quality. Every change the artist makes goes back into
BRAVOH's room, and the desk hears about it on its next turn. The address is
`#/editor?door=<url>`, where the door is a capability URL that BRAVOH signs (its `apps/api/src/routes/reel.ts`):

| door | what it does |
| --- | --- |
| `GET <door>` | Returns the project JSON as the engine saves it. Every media item's `originalUrl` is a fresh hour link to the original file. |
| `PUT <door>` | Saves the whole project, about 1.5 s after the last change (`door.ts`, `keepSaving`). A 409 means BRAVOH's make is cutting the video: the save waits and retries every 10 s. |
| `POST <door>/cut?name=` | Sends each video the artist exports (mp4, mov, webm), as well as downloading it. |

The page needs no cookie of the host's, so it runs on its own origin (`reel.bravoh.ai`). It shares no storage with the
studio. The engine page's load and this page's open are one function (`services/open-saved.ts`). Media opened from a
host is not copied into IndexedDB (`replaceMediaAsset(..., { persist: false })`), because the next open fetches it
again from the host.

## Go / no-go, measured 15 Nov 2026

**Setup.** This branch's production build was served with the nginx headers from `services/openreel/Dockerfile`
(COOP `same-origin`, COEP `require-corp`, CORP `same-origin`) on its own origin. A stand-in door answered with the
headers of BRAVOH's `/api/files/raw/<token>` (CORS `*`, CORP `cross-origin`).

**The project.** A real save made through `window.engine`, the way make makes one: 1080x1920 at 30 fps, two clips
(mp4 and mov H.264, 8.4 MB and 13.9 MB), a 48 kHz WAV, and three picture clips over one audio clip.

**The run.** Each run edited as an artist does: the middle clip pressed on the timeline, then Delete. It then
exported with the toolbar's Export, Export Video (MP4 at the project's size).

| # | question | Chrome 148 (top-level tab) | Playwright WebKit 26 (top-level, the Safari engine) | in an iframe of a plain (non-isolated) host page | Mac app (Tauri WKWebView) | iPhone |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `#/editor` opens a given project, its media relinked from fresh links at original resolution | **GO**: 1.4 s. Each file is byte-identical to the original (8,409,230 / 13,869,145 / 3,840,078), 1080x1920, no proxy (proxies are only made on request) | **GO**: 1.4–2.0 s, the same | **GO** in both engines | Not embedded: the app hands every new window to the artist's browser (`apps/desktop/src-tauri/src/outside.rs`), so this column is the browser's | WebKit with Playwright's iPhone 15 Pro profile: opens in 1.5 s, OpenReel's own phone layout |
| 2 | An edit saves back through the bridge into the room's `video.openreel.json`, with the previous save backed up | **GO**: the save lands 1.5 s after the edit, the backup is written, and the chip reads "Saved to BRAVOH" | **GO**, the same | **GO** | (the browser's) | Saves in the emulation |
| 3 | Headers | `crossOriginIsolated` true with the container's own three headers: SharedArrayBuffer, VideoEncoder/Decoder, AudioEncoder, OPFS and WebGPU are all present | true, with the same set | **Not isolated** (no SharedArrayBuffer), because a frame can't be isolated under a parent that isn't. The editor still opens, edits, saves and exports on WebCodecs. The studio page would need COEP to give it isolation, which today's pages have only for booth artists (`credentialless`, which Safari doesn't know). Decision: **a top-level tab, not a frame** | The app's WKWebView is not used. A Tauri window of its own would need its custom protocol to answer COOP/COEP; this is not needed while the browser holds it | Unmeasured on a real device (memory against full-size footage) |
| 4 | Export at full quality into the room as the conversation's cut | **GO**: 5–7 s for the 12 s cut. H.264 High 1080x1920 at 30 fps, 10.5 Mbps, AAC at 190 kbps; the file reaches `<door>/cut` | **GO**: 6–8 s. H.264 1080x1920 at 10.9 Mbps, but **AAC at 38.6 kbps** on a sine test tone (VBR spends nothing on a pure tone, so check on real music) | **GO** in both | (the browser's) | Not measured |

**Verdict.**

- **GO** for desktop Chrome and Safari, and for the Mac app through the artist's browser.
- **iPhone: no-go for now.** The press isn't drawn on a phone; real-device memory is unmeasured.
- **No iframe.** A top-level tab gets isolation and the whole screen.

## The changes on this branch

- `door.ts`, `App.tsx`:
  - the door mode, with the "Saved to BRAVOH" chip;
  - a project opened from the door; no recovery dialog or welcome screen over it.
- `services/open-saved.ts`: the engine's load and relink, shared.
- `services/export-runner.ts`: `sendExportsTo`, so every finished download also goes through the door.
- `stores/project/media-slice.ts`: `replaceMediaAsset` takes `{ persist: false }`.
- Found along the way: React's double effect in development opened the door twice, and the second relink raced the
  first ("The media or project changed while replacing the file"). `openDoor` now runs once per page.

## Known limits

- Media the artist imports in the editor from their own disk stays in their browser. BRAVOH's room never gets it, so
  make's next run sees that clip without its file. Uploading new media through the door is the next step.
- The first-run tour (`openreel-onboarding-complete`) shows to an artist on their first open. It is OpenReel's own,
  and it was kept.
