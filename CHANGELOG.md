# Changelog

## 1.2.0

### New

- **Live wallpaper opacity**: an *Opacity* slider at the top of the panel's *Wallpapers* section darkens the wallpaper while you drag it, without reopening the window or changing the files. The wallpaper and the background keep separate opacities: the slider sets the one chosen with *w* / *b*. The window reopens once, the first time, to load the CSS it needs.
- **Theme from wallpaper** (off by default): VS Code's colors come from the wallpaper's palette and follow it each time it changes, with every text color checked for contrast. It can be turned on while a wallpaper is set; turning it on asks first and switches to VS Code's own dark theme, so Doki's colors don't mix in. The palette can come from the background instead with `dokiCarousel.paletteSource`.
- **w** and **b** buttons on the panel's preview switch *Apply as* between Wallpaper and Background in one click. A grey ring marks the chosen one (both with *Both*), and each turns yellow while that image shows a file.
- **Loops in GIF optimization**: with one GIF picked, yellow dots on a track show where its animation starts over. Click one to keep just that loop in *Start* and *Duration*; a *Match* slider sets how alike the frames must be.
- **Wallpapers too large for VS Code are caught before applying.** VS Code can load up to 360 MB of images, wallpaper and background together (the same on every computer). Past that, Doki failed and showed its page about file permissions, which had nothing to do with it. Now the extension explains the problem and offers to open **GIF optimization** with the file already picked, or to switch off the other image to make room. Files that don't fit are marked with ⚠ in the panel's list and the status bar list, and the arrows and *Random* skip them. See *How large a wallpaper can be* in the README.
- **Uninstalling** removes the colors the extension added to `workbench.colorCustomizations` and asks whether to uninstall Doki Theme too.
- *Optimize GIFs* from the command palette opens its section of the panel.

### Removed

- **Set opacity**, **Reset opacity** and the conversion's **Video opacity**: the Opacity slider does the same without rewriting the files. Wallpapers darkened with them are still brightened in the hover previews.

### Fixed

- **GIF optimization** with a *Start* above 0 failed with "Error opening input file …palette….png". The fragment is now cut inside ffmpeg's filters, so the palette is made from the kept frames only.

## 1.1.0

- **Every format Doki can show**: the carousel now lists GIF, PNG (also animated APNG), JPG/JPEG/JFIF, WebP, AVIF, BMP and ICO wallpapers, not only GIFs. The button is now *Set wallpaper folder…*, with the accepted formats shown below it. SVG and TIFF are left out: VS Code can't display them as a wallpaper.
- **Set opacity**: darken wallpapers you already have with an opacity slider (the same "opacity over black" as the video conversion), so they can be used without hiding the code. Pick the files and a destination folder; saving into their own folder replaces them, after a confirmation dialog. Works with every format above except animated WebP, and keeps format, size, animation, frame timing and transparency.
- **GIF optimization**: make existing GIFs lighter with a lower FPS, a new size or only a fragment, into another folder or replacing them.
- When *Set opacity*, *Reset opacity* or *GIF optimization* replaces the current wallpaper, it is loaded again automatically once all the files are done.
- **Reset opacity**: brightens files darkened with Set opacity back (close to the original, not identical).
- **Remove the wallpaper** with the ✕ on the panel's preview or the *Remove Wallpaper* command. Doki's stickers stay, unlike with Doki's own *Remove Sticker/Background*.
- **Wallpaper in editors** option: hide the wallpaper from code, the Welcome page, Settings and tabs while keeping it in the side bars, panel and terminal. The window reopens to apply it.
- Fixed: unticking **Wallpaper in terminal** now really hides the wallpaper there. The terminal gets the theme's background color instead of falling back to the transparent panel color.
- Fixed: applying an image as **Background** did nothing when Doki's background was switched off (`doki.background.enabled`); applying now turns Doki's switch on. The panel explains the difference between Wallpaper and Background.
- **Sort by** and **Refresh list** moved next to the filter, above the list. Sort by now includes the direction ("Newest first", "Name (Z → A)", …), so the separate *Order* list is gone.
- The *After changing* option (`dokiCarousel.reloadMode`) is gone: the window is always reopened, the only way installed VS Code shows a new wallpaper.
- Hover previews for every format; files ffmpeg can't read (animated WebP) are shown as they are.
- Panel: the two video tools are grouped in a **.mp4 videos** section, the **Appearance** section moved to the bottom, short explanations were added, and space for the scroll bars is always kept so nothing jumps sideways. Open sections are remembered by name.

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
