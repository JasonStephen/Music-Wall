# Music Wall

Organize albums and playlists, create local playlists, and listen inside your Obsidian music library.

[中文](README.md)

## Installation

Add `JasonStephen/Music-Wall` through BRAT, or copy `main.js`, `styles.css`, and `manifest.json` from a release into `.obsidian/plugins/music-wall/`. Enable Music Wall in Community plugins.

## Your music wall

Open Music Wall from the music library to browse Created playlists, Saved playlists, and Saved albums. These collections are independent of your NetEase account playlists.

All three categories support nested folders. Add collections with the toolbar, or drag album and playlist search results into the corresponding sidebar category or folder. Opening saved album or playlist details fetches current tracks online.

Local playlists support editing names, descriptions, and tracks. Covers are generated from their songs. Clone a playlist to create a local copy with the same name and song order.

## Organizing and listening

- Ctrl-click (Command-click on macOS) toggles selection; Shift-click selects a range.
- Drag to reorder at any time. Drag albums or playlists into folders to move them. Sidebar and main content share their order.
- Drag songs from search or another playlist into a local playlist to copy them, skipping duplicates.
- Album grids offer vinyl, CD, cassette, and cover styles. Playlist grids and all lists use covers. Appearance preferences apply across the wall.
- Use the fixed toolbar to sort, add, search, or change layout. Back and the mouse back button return to the previous page.
- The player slides up within the music library. Collapse it with the top-left down arrow to resume browsing.

## Storage

Your wall is stored in `MusicWall/music-wall.json` inside the vault. Include this file in your backups. Legacy `.mw` files no longer open as separate walls; existing migration records remain, and you can organize the original files yourself.

Configure your NetEase connection, playback, lyrics, and appearance in the plugin settings.
