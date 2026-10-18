# Music Wall

Turn your NetEase Cloud Music albums into a wall of real-looking records
inside Obsidian.

Every album can look like a vinyl, a CD, a cassette, or a plain cover,
lined up neatly on your wall. Click a record and Music Wall plays
it. Everything you collect is one glance away.

Your collection lives in a `.mw` file inside your own vault — just a plain
text file you can back up or send to a friend. It stays in your hands.

*中文介绍见 [README.md](README.md)*

---

## Up and running in three minutes

### Step 1: Install the plugin

1. Open the folder of your Obsidian vault;
2. Inside it, find the `.obsidian` folder, then the `plugins` folder
   (can't see `.obsidian`? It's hidden — enable "Hidden items" in your
   file manager's View menu);
3. Create a folder named `music-wall` inside `plugins`, and put these
   three files in it: **main.js, styles.css, manifest.json**;
4. Back in Obsidian: Settings → Community plugins, refresh, and switch
   on **Music Wall**.

> Tip: the release page of this plugin offers a zip with all three
> files — just unzip and follow the steps above.

### Step 2: Create a wall

Pick whichever feels easiest:

- **Right-click any folder** in the file list → "New music wall";
- Click the **record icon** in Obsidian's far-left ribbon;
- Press `Ctrl+P` to open the command palette and type "music wall".

A new tab opens at once — that's your first (empty for now) music wall.

### Step 3: Put your first album on it

1. Click the **＋** button at the top right of the wall — a small panel
   pops up;
2. Type an album name (e.g. "Fantasy") and hit Enter, then pick the
   right one from the results;
   - Tip: you can also paste a NetEase share link directly;
   - Adding many at once? Click "**Batch**" in the panel and paste album
     IDs separated by semicolons (the ID is the number after `id=` in the
     album's web address);
3. Check the cover and track list in the confirmation window, confirm —
   the record is on the wall.

### Step 4: Listen

Click a record → hit play in the detail window.
Albums play in track order inside Music Wall by default, without installing
the NetEase client or creating/replacing account playlists. The player page
supports pause, previous/next, track selection, seeking and volume. Commands
also let you pause/resume or stop internal playback.
The footer places previous, play/pause and next beside the song details, with playlist, quality, volume and expand controls on the right. Its top progress bar supports seeking.
Playing keeps your current wall open. A footer on every open wall controls the
same global player. Click its cover/title or expand button, or the player icon
in the left ribbon, to open the full player. An existing tab is focused;
the player opens as an independent page without a file.
The volume button beside the track-list button opens a vertical slider. Click outside to close the track list or style panel.
Use a record's menu to add it to the album queue. Pending albums can be reordered by dragging or arrow buttons. Any album can be removed; removing the current one advances playback.
Album playback supports in-order, queue repeat and single-song repeat. Playlist playback also supports shuffle.
The music-library ribbon opens your created and saved playlists, liked songs and playlist search. Play a list or append it to the song list. Switching between album and playlist playback preserves both queues and their positions.
The library footer shares the wall's mini player, current song, queues and controls.
In the player's style panel, vinyl and CD cases offer White, Black, Wood or Cover color, with material details always enabled. Case colors and page backgrounds are set separately. Cover color also tints the vinyl record and its recessed well.
The quality menu shows verified qualities for the current track/account and
labels the actual audio quality. Settings offer 128kbps, 192kbps, 320kbps, Lossless and Hi-Res, with
automatic fallback to the best available lower quality. Player changes apply
to the current session, preserving position and pause state where possible.

**Your first preview or play opens a sign-in QR code.** Scan it with the
NetEase mobile app and confirm. You can also sign in or out in plugin
settings. Browsing, searching and organizing do not require sign-in.
The temporary queue stays in memory. Closing the player tab keeps audio
running; stopping, signing out or disabling the plugin clears the queue.
Settings let you switch back to NetEase client playback, which retains the
dedicated-playlist method for whole albums.

That's all you need to know. Everything below is optional fun.

---

## Make it yours

### 🎨 Looks and layouts

- **Four record styles**: vinyl, CD, cassette, plain cover — switch any
  time and the whole wall changes together;
- **Three layouts**: grid (big posters), list (compact rows), and the
  **shelf** — a dark wooden rack where records lean, slide out on hover,
  and vinyl half-slips out spinning slowly.

All in the first toolbar icon "Style & layout", each with a real
thumbnail preview. Your choice is remembered across restarts.

### 🗂 Groups: divide the wall into sections

**Right-click any empty spot** on the wall → "New group" to organize
records your way ("Chinese pop", "for running"…). Groups can be
collapsed, renamed, and reordered. Deleting a group that still holds
records asks you to type its name first — no accidental wipes.

### 🔃 Finding things: sort, filter, search

- **Sort**: manually (long-press to enter layout editing, then drag),
  by added date, album name, artist, release year, or **rating** —
  any direction you like;
- **Filter**: by artist, era, or rating, with multi-select (e.g. only
  "Jay Chou" or only 5-star albums);
- **Search**: the magnifier at the top right searches your collection
  by keyword.

### ⭐ Rate your albums

Right-click any record → "**Rate…**" and give it 1 to 5 stars. Rated
records show a little star with the score in their corner, and the
detail view lights up the matching stars. Afterwards you can sort by
rating (favorites first) or filter by it (high scores only).

Ratings live inside the wall file — share the wall and your ratings
travel with it.

### ☑ Multi-select and batch moving

The toolbar "**Select**" enters picking mode: click records one by one,
then migrate the whole batch to another wall at once — or simply drag
the whole pile onto another open wall.

### 🧱 Many walls, easy moving

Build as many walls as you want ("Best of Chinese pop", "2026
listening diary"…). Right-click a record → "Migrate to another wall…"
to move it; duplicates are detected by album automatically.

### 📖 The shelf's "gatefold" surprise

Click a record on the shelf: the camera pushes in, the record box grows
to center stage, then **opens like a real gatefold** — album info and
tracks on the left, the disc on its tray on the right; click the disc
to play. `Esc` or × closes it back into place.

### 🔍 Too small? Zoom

There's a zoom slider in settings (50%–200%); handier still: hold
`Ctrl` or `Alt` and scroll right inside the wall.

### 🔒 Lock a record

"Lock" in a record's ⋯ menu freezes its info from editing (it can still
play, restyle, or be deleted) — great for albums you've already
curated perfectly.

### 📤 Share a wall with a friend

"**Export current wall**" in the ⋯ menu gives you a `.mw` file; send it
over, and they use "Import .mw file" to recreate your wall exactly.
**Your cookie and account info are NOT in the wall file** — share away.

(Power users can also "Import from a Git repository" — desktop only.)

### 🎧 The player page: a wall just for listening

Open the independent player page from the left ribbon. Drag a record into it from any wall, and it becomes a **record
player**: turntable, CD deck, or big-cover device, with white / dark /
cover-tinted / wooden-floor backgrounds. The play button even picks up
the cover's color — a fresh look every day.

### ▶ Syncs with what you're hearing (Windows)

Tick "Enable SMTC" in the NetEase app settings, and the plugin knows
what's playing on your PC: the player page shows the current track and
lets you skip; the matching record on your wall gets a glowing ring and
spins along. Turn it off anytime in settings (automatically ignored on
non-Windows systems).

### 🌐 Interface language

The plugin follows Obsidian's language by default (Simplified Chinese,
Traditional Chinese, and English included); you can also pick one
yourself in settings.

---

## What's on the settings page

| Setting | In one line |
| --- | --- |
| Interface language | Follows Obsidian by default, or set your own |
| NetEase account | QR sign-in, check sign-in and sign out; preview and play require sign-in |
| Playback mode | Internal playback by default, with the original NetEase client mode available |
| Default audio quality | Standard through Hi-Res, matched to each track and account's available qualities |
| Sign-in, APIs and privacy | Interface sources, credential storage, playback permissions and sign-out scope |
| Playback playlist | Client mode only; attempts to create or reuse a dedicated private playlist |
| Default style / shelf captions / column width / player background / zoom | Look-and-feel preferences, change anytime |
| SMTC now-playing | Toggle the "what's playing" sync (Windows only) |
| Git URL / branch / subdirectory | Advanced: import wall files from a Git repo |

---

## Frequently asked

**Clicked play and nothing happened, or only a snippet played?**
Sign in to the plugin and check your connection. Internal playback labels
preview clips and skips tracks without available audio. Full playback still
depends on account permissions and music rights. Client playback additionally
requires the NetEase app and its own sign-in.

**Which sign-in API is used, and where are credentials saved?**
QR sign-in follows [NeteaseCloudMusicApiEnhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced),
using the existing encryption layer to contact NetEase directly. No separate
API server is required. Search, album and playlist interfaces retain their
existing implementation. Sign-in credentials (cookies) are saved unencrypted
in this vault's plugin settings and may be copied by vault sync or backups.
They are not included in `.mw` files. Do not publicly share plugin settings.
Signing out clears this plugin's credentials and playlist selection; it does
not sign out the NetEase client or delete playlists. Settings include concise
account and privacy information.

**Does it work on my phone?**
Yes for browsing, searching and internal playback; client mode can open
the NetEase app. Git import and client now-playing sync are desktop-only.

**Where is my data? Is anything uploaded?**
Everything is in plain `.mw` text files inside your own vault. The
plugin never sends your data anywhere third-party — it only talks to
NetEase's servers to fetch album info, sign in and retrieve playback audio.

**Deleted something by mistake?**
Deleting records or groups always asks first (a group with records
inside even makes you type its name). Deleted the whole `.mw` file?
Check your system recycle bin, just like any note.

**Moving to a new computer?**
Copy the `.mw` files into the new vault, install the plugin, open them —
everything is exactly as before.

**Lyrics, downloads, listening charts?**
No — for copyright reasons, this plugin does just three things:
**collect, organize, and play**.

---

## License

MIT
