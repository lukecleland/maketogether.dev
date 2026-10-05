# Make Together

A live peer-to-peer workspace for video chat, shared media, drawing and music
collaboration. Create a room, share its link and work together without an
account.

Rooms support up to four people. Media and collaborative state travel directly
between participants over WebRTC; PeerJS Cloud is used for signalling.

## Current features

### Rooms and video

- Up to four participants in a full peer-to-peer mesh
- Wider portrait camera and microphone panels for each participant
- Local microphone mute and camera on/off controls without leaving the room
- Data-only participation when camera or microphone access is denied or
  unavailable
- Automatic reconnection and room-owner handover when the original host leaves
- Participant video shortcuts kept in the shared dock
- Participant count and a clear room-full state for a fifth connection
- Per-participant microphone mute and camera controls

### Infinite collaborative canvas

- Pan and zoom around a shared dot-grid workspace
- Draw continuously behind and around floating panels
- Ballpoint, pencil, fountain pen, charcoal, highlighter, neon and eraser tools
- Adjustable colour, width and nib-specific rendering, including metallic inks
- Place and re-edit free text directly on the canvas
- Draw rectangles, ellipses, straight lines and arrows, with Shift-constrained proportions and angles
- Connect shared panels with attached lines that follow them as they move or resize
- Clear the shared whiteboard
- Resolution-independent coordinates so content maps between different screen
  sizes
- Mouse, touch and mobile Safari interaction support
- Automatic local snapshots of drawings, widgets, layout, connectors and navigation

### Shared widgets

- **YouTube player** — load links by pasting or dropping them onto the canvas;
  play, pause and seek state is shared
- **DAW** — a shared multitrack window for uploaded audio and microphone takes;
  arrange waveform clips, trim, duplicate, rename, mute/solo, adjust gain and pan,
  and export a stereo WAV mix. Edits, mixer controls, playback and recording
  transport are shared with peers, along with completed takes and source files.
- **Audio player** — compact Digital player by default, with a theme dropdown
  for Record player and Tape deck. Tape reels rotate during playback and
  mechanical controls include ten-second rewind/forward. Themes, play, pause
  and seek state are shared and saved.
- **Screen sharing** — share a browser tab or window to browse together. The mini
  browser is disabled while reliable browsing sync is unavailable.
- **Sticky notes** — switch between text, guitar chord diagrams and tablature;
  notes can contain multiple chords
- **Code editor** — write or paste syntax-highlighted snippets and format
  supported languages collaboratively
- **Canvas recorder** — record the visible board, drawings, connectors and
  panels through an in-app compositor without a screen-share prompt; share
  clips and synchronize their playback
- **PDFs** — drop files onto the canvas or choose **PDF** in the widget menu.
  Pages fit the panel and Previous/Next navigation is shared with participants.
  Files up to 50 MB are transferred to peers and retained locally, including for
  late joiners. Room exports retain filenames and page numbers; use **Restore PDF**
  when the original file is missing after import. Password-protected PDFs need an
  unlocked copy. This viewer displays pages; it does not edit forms or annotations.
- **Images and screenshots** — paste, drop or upload an image into a shared,
  resizable panel; large files are resized and compressed before transfer
- **Video panels** — one independently movable panel per participant

Widgets can be dragged from their non-interactive surfaces, resized from every
edge or corner, layered consistently across peers and tagged with a double
click. Every widget can also be minimised into its dock chip and restored in
place; restoring never moves or zooms the canvas.

### Sharing and navigation

- **Fit Screen** frames all canvas content; **Show all** opens a temporary
  Mission Control-style overview of live panels, including minimized panels.
  Select one to focus it, or use Done/Escape to return. Both system controls
  stay at bottom right, separate from the shared dock.
- A shared dock acts as a set of bookmarks into the canvas
- Tag, rename, remove and jump to panels without relocating them
- Ping a dock entry to draw the other participants' attention
- See named, colour-coded participant cursors and toggle a fading laser trail
- Double-click a participant in the dock to request their current viewport, or
  offer yours; applying a suggested view always requires explicit acceptance
- Hold the canvas to create a position flag with a ripple
- Select and tag an area, then return to it with a framed zoom
- Invite the room to follow your viewport in an opt-in presentation mode;
  followers can leave at any time
- Paste images, plain text and YouTube links directly onto the canvas; other URLs
  are added as text
- Drop image and audio files and transfer them to peers in chunks with progress feedback
- Export the shared workspace as a portable JSON bundle and import it later;
  media filenames and playback metadata are included, but media bytes remain local
- Late joiners and reconnecting participants receive the current room snapshot
  and available media from the host over the P2P connection
- Summon a participant via Message, WhatsApp, Email or a copied link — uses the native share sheet on mobile

### Session continuity

- Room layout, drawings, notes, code, dock entries and viewport are saved in
  the browser and restored when that browser revisits the room
- Audio files and completed canvas recordings are retained locally in IndexedDB
- A participant joining an active room receives the current room snapshot and
  transferred media from the host

## Important current limitations

- **Persistence is browser-local.** Room snapshots are stored in `localStorage`
  and media files in IndexedDB. There is no shared application database, so a
  room cannot be recovered on a different browser unless a participant imports
  a previously exported bundle; bundle files contain media metadata, not bytes.
- **TURN is optional but operationally important.** Direct WebRTC can fail
  between cellular devices, strict NATs and restrictive corporate networks
  unless a TURN relay is configured.
- **Four participants is a deliberate ceiling.** A full mesh creates a direct
  media connection between every pair and does not scale like an SFU-backed
  conferencing system.
- **Mini browser is disabled.** Use **Share screen** to browse together. Existing
  browser panels show a disabled notice; their saved data is retained.
- **Browser media policies still apply.** iOS and other browsers may require a
  tap before remote audio can play, and autoplay restrictions can delay a
  remotely triggered player.

See [ROADMAP.md](ROADMAP.md) for cloud persistence, music mode, live screen
sharing and other feature candidates.

## Connection model

The room owner registers the lower-cased room code as its PeerJS ID. Guests
connect to that ID, receive the participant roster and establish the remaining
connections required for a full mesh:

```text
             Participant A
              /    |    \
             /     |     \
Participant B----- C -----D
```

Application messages are broadcast across the mesh, with message ids preventing
duplicates when peers relay them. Media calls and data channels remain direct
between browsers. If the room owner
disconnects, the remaining clients elect a replacement owner so the room code
continues to work while anyone remains connected.

STUN servers help browsers discover direct routes. A configured TURN server
relays encrypted WebRTC traffic only when a direct route cannot be established.

## Shared state

The WebRTC data channel carries typed messages for:

- Panel creation, movement, resizing, stacking and removal
- YouTube, audio and browser state
- Whiteboard strokes, shapes, text, connectors and clearing
- Sticky-note and code-editor updates
- Dock tags, labels and pings
- Position and bounded-area tags
- Room snapshots, imports, viewport handoffs and presentation-mode updates
- Ephemeral participant cursor and laser-pointer positions
- Chunked image, audio-file and recording transfers
- Collaborative code and synchronized recording playback

Panel geometry and canvas coordinates are normalized before transmission so
participants with different viewport sizes still share the same logical
workspace. YouTube and audio playback commands include a wall-clock timestamp
so receivers can compensate for data-channel transit time.

## Local development

Requirements:

- Node.js 20 or newer
- npm
- A secure browser context for camera and microphone access (`localhost` is
  accepted by browsers)

Install dependencies and start Vite:

```bash
npm install
npm run dev
```

Open the displayed local URL, start a session and join it from up to three other
tabs, browsers or devices using the generated link.

Available commands:

```bash
npm run dev       # development server
npm run build     # TypeScript check and production build
npm run lint      # ESLint
npm run preview   # serve the production build locally
```

## TURN configuration

Copy the example environment file:

```bash
cp .env.example .env.local
```

Configure the UDP and TLS/TCP endpoints supplied by your TURN provider:

```dotenv
VITE_TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:443?transport=tcp
VITE_TURN_USERNAME=replace-with-turn-username
VITE_TURN_CREDENTIAL=replace-with-turn-credential
```

Vite embeds `VITE_*` values in the client bundle. Do not place a provider's
account password or API secret in these variables. Prefer scoped or short-lived
TURN credentials when the provider supports them.

## Persistence

Rooms are currently persisted only in the browser that used them. A versioned
snapshot in `localStorage` holds the board and layout, while IndexedDB holds
local image, audio and recorder files. The host also uses that snapshot format
to hydrate late joiners and room-bundle imports.

Supabase is **not currently wired into the application**. Cross-browser,
account-backed persistence would still require:

- A schema and migrations, normally stored under `supabase/migrations/`
- Client configuration and public project environment variables
- Authorization and room access policies
- Background snapshot writes and database hydration
- A media-storage policy if files should travel with portable room backups

The intended architecture is for live collaboration to remain P2P while a
database stores durable snapshots in the background.

## Production deployment

`npm run build` writes the static production application to `dist/`. It can be
served by Netlify, Vercel or another static host.

Production hosting must use HTTPS for camera, microphone and WebRTC browser
APIs. Configure the TURN environment variables before building because Vite
injects them at build time.

No application backend is required for the current browser-local version, but
the app still depends on third-party network services such as PeerJS signalling,
configured STUN/TURN infrastructure, YouTube and any pages opened in the mini
browser.

## Project structure

```text
src/
├── components/
│   ├── AudioPlayer.tsx        # shared record-player widget
│   ├── BrowserWidget.tsx      # synchronized iframe browser
│   ├── CodeWidget.tsx         # shared code editor and formatter
│   ├── Dock.tsx               # canvas bookmarks and participant shortcuts
│   ├── DraggablePanel.tsx     # movement, resizing and tag gestures
│   ├── ImageWidget.tsx        # pasted, dropped and uploaded images
│   ├── ScreenRecorderWidget.tsx # local display capture and shared playback
│   ├── StickyNote.tsx         # text, chord and tab notes
│   ├── SummonButton.tsx       # invite participant via Message, WhatsApp, Email or copied link
│   ├── VideoGrid.tsx          # side-by-side local and remote video
│   ├── VideoPanel.tsx         # local and remote video
│   ├── Whiteboard.tsx         # drawing, shapes, text and region selection
│   ├── WhiteboardToolbar.tsx  # canvas tools and properties
│   └── YoutubeWidget.tsx      # YouTube loading and playback sync
├── hooks/
│   ├── usePeer.ts             # four-person PeerJS mesh and reconnection
│   ├── useYouTubePlayer.ts    # YouTube IFrame API wrapper
│   └── useYouTubeSync.ts      # shared data-channel message router
├── pages/
│   ├── Home.tsx               # create and join flow
│   └── Session.tsx            # canvas and shared-session coordinator
├── types/
│   └── panels.ts
└── utils/
    ├── brush.ts
    ├── code.ts
    ├── fileTransfer.ts
    ├── image.ts
    ├── roomBundle.ts
    ├── roomCode.ts
    ├── roomPersistence.ts
    └── wordList.ts
```

## Technology

| Technology | Role |
| --- | --- |
| React 19 | User interface |
| TypeScript 6 | Static typing |
| Vite 8 | Development and production builds |
| Tailwind CSS 4 | Styling |
| PeerJS / WebRTC | Signalling helpers, media and data channels |
| YouTube IFrame API | Embedded video playback |
| react-draggable | Panel movement |

## Production domain and rebrand

The production domain is `maketogether.dev`. Serve the `dist/` output over HTTPS
and configure the hosting provider and DNS for this domain. Room invitation links
use the current origin, so development and preview rooms keep working as well.

When moving an existing deployment, configure the old host to redirect to
`https://maketogether.dev` while preserving the path and query string (including
`?room=...`). DNS, TLS and redirects are managed outside this repository.

Browser-local rooms and media do not transfer between domains. Export room
bundles on the old origin and import them on the new one; media files must be
added again because bundles contain metadata, not media bytes. The legacy
`watchtogether` storage, bundle-format and peer-message identifiers are retained
for compatibility with existing data and clients.

## DAW

Choose **DAW** from the widget toolbar (or **Add widget** on smaller screens).
Use **Track → New Audio Track**, or right-click a track header, to add and manage
tracks. **Add audio** opens a three-choice dialog: create an empty audio track,
upload audio, or create a MIDI software-instrument track. Each uploaded or dropped
file creates its own new track at the bottom, even when another track is selected.
Press **R** to record into the selected track, or create one when none is selected. Tracks can contain multiple regions; deleting a region leaves its
track and mixer settings intact. Remove tracks explicitly through the Track menu
or their right-click menu.

Drag the grip beside a track name to reorder tracks; a line shows the drop
position. Focus a grip and use Up/Down for keyboard reordering, or Escape to
cancel a drag. Track order is saved and shared with participants.

Drag regions to move them and drag their edges to trim. The **Edit** menu and
region right-click menu provide copy, cut, paste at playhead, duplicate, split at
playhead and delete. Each track header contains mute, solo, volume and a pan dial.
Drag the dial vertically, use its arrow keys, or double-click to center it.
**File → Export WAV** renders the mix locally. Missing source files must finish
transferring or be restored before playback/export; use **Restore missing audio…**
after a metadata-only room import. Existing one-clip projects migrate automatically.

Projects support up to 30 minutes; individual uploads are limited to 50 MB and
must use an audio format the browser can decode. Microphone recording requires
HTTPS or localhost and microphone permission. Software-instrument tracks provide
a basic triangle-wave synth with an on-screen C4–C5 keyboard. Record notes with
R/Record, stop with Space/Stop, and play/export them with the rest of the mix.
MIDI note regions are shared and saved as notes; there is no hardware MIDI input,
MIDI-file import, piano-roll editor, effects, beat grid or synchronized transport.

Zoom fully left (or **View → Fit Entire Project**) to fit the entire arrangement
in the available timeline width. The fit updates when the window is resized.
Waveforms include both channels and retain short peaks, with detail matched to
the visible timeline instead of a fixed number of bars.

Track settings and individual regions merge independently. Concurrent edits to
the same region use logical revisions and a deterministic tie-breaker; removal
wins over stale edits. Arrangements and source audio use the existing browser-local room
storage and are sent to late joiners. Participants must be connected to exchange
changes: this is not a server-hosted project library or offline collaboration.
Room JSON exports include arrangement metadata but omit the audio files.

### Audio region editing

Select a recorded or imported audio region to open its region controls. Drag
its body to move it, its lower side edges to trim, or the **↻** handle in the
upper-right corner to repeat the trimmed recording. The loop handle has a
44px touch target on iPad and other touch screens; left/right keys on the
handle remove/add a repetition. Repeats can end partway through a recording. Each visible repeat has its own
rounded outline, dividing edge and title, including partial first/last repeats.
The region controls also offer rename, exact position and source trims,
loop length, gain, playback speed, reverse, and reset settings. Playback speed
changes pitch and region length. Snap aligns region moves and loop lengths to
the current tempo's beat grid. MIDI note editing is outside this workflow.

Copy, cut, paste, duplicate, split at the playhead, delete, move to another
audio track, and join with the next audio region are available from the region
controls. Joining renders a new shared WAV, retaining any gap between the two
regions. Shared file limits also apply to joined audio. Undo/Redo (Cmd/Ctrl+Z
and Shift+Cmd/Ctrl+Z) restore local region edits, including one complete loop
drag or track move. Undo refuses to replace a region changed by another client.
Loops and region settings synchronize with peers, survive saved/exported rooms,
and are included in WAV export. Original recordings remain unchanged.

### DAW transport and keyboard

The transport provides go-to-start, rewind, forward, stop, play/pause and record
buttons, plus a playback/recording time display. Stop leaves the playhead in
place; Return goes to the beginning and continues playing if playback was
already running. Playback and seeking continue through empty timeline space,
beyond the last clip, up to the existing 30-minute project limit. The ruler
remains available in an empty project and expands without shrinking the time
scale as playback or recording advances.

**Click** toggles a 4/4 metronome during playback and recording. **Count in**
adds four clicks before a microphone or instrument take; Stop cancels a pending
count-in. **Tempo** sets 30–300 BPM (default 120). These controls are shared
with connected participants and late joiners. Tempo affects the click and
count-in; it does not stretch recordings. The click is not included in exported
mixes. Seeking on the ruler also preserves playback. Single-click a
track name to select it, and double-click (or choose **Rename**) to edit it.

Shortcuts apply only to the focused DAW window. Text fields, number fields and
sliders retain their normal keyboard behavior; clicking elsewhere releases the
DAW shortcuts. Open **?** for the in-window reference.

| Key | Action |
| --- | --- |
| Space | Play/pause, or finish an active recording |
| R | Start/finish a microphone take |
| Return | Go to beginning |
| Delete / Backspace | Delete the selected region |
| Up / Down | Select the previous/next track |
| Left / Right | Seek 1 second; Shift seeks 5 seconds |
| Alt + Left / Right | Nudge the selected clip 0.1 seconds; Shift nudges 1 second |
| M / S | Toggle mute/solo for the selected track |
| Cmd/Ctrl + D | Duplicate the selected region |
| Cmd/Ctrl + T | Split the selected region at the playhead |
| Cmd/Ctrl + C / X / V | Copy / cut / paste a region |
| Alt + Cmd/Ctrl + N | New audio track |
| + / - | Zoom the timeline |
| Escape | Deselect and close shortcut help |

Track edits, track/region selection, timeline zoom, playback, pause, seeking and
recording activity are shared with every connected participant. Any participant
can stop a take; only the person who starts it captures their microphone. Live
waveforms and MIDI notes appear while recording, and the completed take/audio
file is shared as before. Instrument-key previews are audible to peers too,
including mixer changes to held notes. Peer Stop commands cancel pending
microphone permission requests and finish active takes without overwriting a
newer transport command when the completed recording is processed.
Late joiners catch up to the current transport, with periodic drift correction.
If the transport owner disconnects, peers stop after an eight-second timeout;
held instrument previews expire after two seconds without updates. Session
activity is transient and does not restart when a saved room is reopened.
Browsers that block automatic audio display **Enable audio**; the shared
playhead still advances. On iPad Safari, the DAW requests a playback-and-record
audio session alongside conferencing, primes Web Audio during a user tap, and
also detects Safari's interrupted context state. **Enable audio** remains
available when playback has not started locally; returning to the page attempts
to resume an interrupted context and rebuild playback from the shared clock.
This is network-synchronized playback, not sample-accurate
remote recording or live microphone audio streaming. Keyboard focus, menus,
file pickers and exports stay local. Recordings use the selected track, or create
one if none is selected.

Completed canvas recordings retain shared play/pause/seek commands while their
files transfer or metadata loads. Playing seeks preserve the playback state;
autoplay-blocked participants can use **Enable audio** to catch up. A local
interaction with the video controls can override a peer's command immediately.
Canvas capture itself records the initiating participant's visible workspace;
its Record/Pause/Stop capture controls remain local.

## Versioning

The tiny version beside the session title comes from `package.json`, injected at
build time. The initial development release is `0.1.0`. Use semantic versioning
(`MAJOR.MINOR.PATCH`): patch for fixes, minor for compatible features, and major
for breaking changes once stable at `1.0.0`. During `0.x` development, use minor
bumps for breaking changes. Bump the version once per release with
`npm version patch --no-git-tag-version` (or `minor` / `major`), and commit both
`package.json` and `package-lock.json`. Rebuild to display the new version.

## Brand assets

The logo has two rounded tiles on the left and a tall tile on the right:

- Lilac: `#D4ACFA` (upper-left tile)
- Violet: `#7048FA` (lower-left tile and primary actions)
- Mixed lavender: `#A27AFA` (right tile, the 50/50 RGB midpoint)

All three are solid fills. `public/brand-mark.svg` is the source artwork;
`BrandMark` renders it in the landing page and session header. The wordmark uses
self-hosted Outfit (SIL Open Font License in `public/fonts/OFL-Outfit.txt`) as a
production match for the concept lettering. Brand accent shades are defined by
`--color-brand-*` in `src/index.css`; activity icons retain their existing colors.

Run `npm run icons:generate` after changing the mark. It regenerates the SVG
favicon, 16/32px PNG favicons, multi-resolution ICO, 180px Apple touch icon,
192/512px app icons, and a maskable 512px icon with safe-zone padding. Commit
both the source and generated files. Update the `tiles-1` asset revision in
`index.html` and `public/manifest.webmanifest` when replacing cached icons.

### Screen sharing

Choose **Share screen** in the right-hand controls (or the mobile **Add widget** menu) to share a screen, window, or browser tab with participants. It temporarily replaces your camera video while keeping your microphone. **Stop sharing**, or the browser’s stop control, restores your camera. System/tab audio is not included.

### Joining an existing room

New participants automatically request the current room snapshot from the active room owner, then receive its media files. This restores shared panels, notes, code, drawings, DAW tracks and saved playback state, including the current size and world position of every participant's AV window. Participant IDs are mapped so the joining client's own window is rendered as **You** at the same location it occupies for everyone else. Newcomers adopt this layout before announcing their own AV geometry. Responses are addressed to the newcomer, so joining does not reset other participants’ views. The handshake retries while connecting and also works after another participant takes over the room.

### Link previews

Slack and other link crawlers receive Open Graph and large-image card metadata
in the initial HTML, including a public 1200 × 630 PNG. Run
`npm run social:generate` to regenerate `public/social-preview-v1.png` from the
existing brand mark and Outfit font. When replacing the artwork, use a new image
filename in both the generator and metadata so cached images can refresh. Room
invitation URLs retain their `?room=` parameter.

### iPhone controls

On narrow screens the header uses two rows; import/export and canvas recording
are in **Add widget**. Use **Pointer** to pan the background with one finger,
or use two fingers to pan and pinch. New panels and dock navigation frame the
panel below the drawing toolbar. Touch resizing ends cleanly when a gesture is
cancelled. YouTube link controls remain visible without hover and videos request
inline playback. The landing form scrolls when the keyboard reduces the visible
viewport. Screen sharing is disabled when the browser does not expose screen
capture; receiving another participant's screen remains available.
