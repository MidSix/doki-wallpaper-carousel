# Changelog

## 1.0.0

First public release.

- Switch Doki Theme wallpapers from a folder with arrows in the editor title bar, the status bar, a side panel and keyboard shortcuts.
- Progress bar while a wallpaper is applied; only one switch at a time per window, so repeated clicks never open extra windows.
- Switching is paused while `.mp4` files are copied, moved or converted, so the window never closes in the middle of them.
- Sort by name, date modified, date created, size or random, with optional subfolders.
- Side panel with a still preview of the current wallpaper (never the animated GIF, to keep it light), a filterable list and cached still-frame hover previews (dimmed wallpapers are brightened in the preview only).
- Wallpaper shown behind both side bars, the bottom panel, the terminal and the command palette (adjustable tint).
- Convert `.mp4` videos to GIF wallpapers (FPS, size, video opacity over black, trimming) with ffmpeg on Windows, macOS and Linux. Videos whose GIF already exists are skipped.
- Collect `.mp4` files from a folder tree into one folder, skipping videos that are already there.
