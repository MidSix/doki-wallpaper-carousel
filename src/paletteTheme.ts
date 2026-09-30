import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ensureTransparentSurfaces, setPaletteColors } from "./doki";
import { PaletteColor, extractPalette } from "./palette";
import { findTool, warnFfmpegMissing } from "./platform";
import { themeColors } from "./themeColors";

// "Theme from wallpaper": VS Code's colors from the palette of Doki's wallpaper (or background).
// The palette is read with ffmpeg (palette.ts), turned into theme colors (themeColors.ts) and laid
// over VS Code's own dark theme through workbench.colorCustomizations (doki.ts), which applies
// them right away, without reopening the window.

const DOKI_ID = "unthrottled.doki-theme";
const PALETTES_KEY = "dokiCarousel.palettes";
const MAX_CACHED = 60;

let context: vscode.ExtensionContext | undefined;
/** Counts the refreshes, so a slow palette read never overwrites a newer one. */
let generation = 0;

const carouselConfig = () => vscode.workspace.getConfiguration("dokiCarousel");
export const isPaletteThemeOn = () => carouselConfig().get<boolean>("wallpaperTheme", false);

export function initPaletteTheme(ctx: vscode.ExtensionContext) {
  context = ctx;
  // A known palette is in place before the extension first updates the colors, which would
  // otherwise take the palette's colors out until it is read again.
  const file = isPaletteThemeOn() ? sourceImage() : undefined;
  const cached = file ? cachedPalette(file) : undefined;
  if (cached?.length) setPaletteColors(themeColors(cached).colors);
  refreshPaletteTheme();
}

const cacheKey = (file: string) => {
  const stat = fs.statSync(file);
  return `${file}|${stat.size}|${Math.round(stat.mtimeMs)}`;
};

function cachedPalette(file: string): PaletteColor[] | undefined {
  try {
    return context?.globalState.get<Record<string, PaletteColor[]>>(PALETTES_KEY, {})[cacheKey(file)];
  } catch {
    return undefined;
  }
}

/** The image the palette comes from: Doki's wallpaper or background, while it shows a file. */
function sourceImage(): string | undefined {
  const source = carouselConfig().get<string>("paletteSource", "wallpaper") === "background" ? "background" : "wallpaper";
  const doki = vscode.workspace.getConfiguration("doki");
  const file = doki.get<string>(`${source}.path`);
  if (!file || !doki.get<boolean>(`${source}.enabled`, true)) return undefined;
  const normalized = path.normalize(file);
  return fs.existsSync(normalized) ? normalized : undefined;
}

/** The palette of a file, read once and then kept while the file stays the same. */
async function paletteOf(file: string): Promise<PaletteColor[] | undefined> {
  const key = cacheKey(file);
  const cache = context?.globalState.get<Record<string, PaletteColor[]>>(PALETTES_KEY, {}) ?? {};
  if (cache[key]) return cache[key];
  const ffmpeg = findTool("ffmpeg");
  if (!ffmpeg) {
    warnFfmpegMissing();
    return undefined;
  }
  const palette = await extractPalette(ffmpeg, file);
  if (palette && context) {
    // Oldest entries out first (objects keep insertion order).
    const entries = Object.entries(cache).filter(([k]) => k !== key).slice(-(MAX_CACHED - 1));
    await context.globalState.update(PALETTES_KEY, Object.fromEntries([...entries, [key, palette]]));
  }
  return palette;
}

/**
 * Lay the palette of the current image over the theme, or take it off: when the option is off,
 * or no image shows (without a wallpaper there is no palette, and VS Code keeps its own theme).
 */
export async function refreshPaletteTheme() {
  if (!context) return;
  const ticket = ++generation;
  const file = isPaletteThemeOn() ? sourceImage() : undefined;
  let colors: Record<string, string> | undefined;
  if (file) {
    try {
      const palette = await paletteOf(file);
      if (palette?.length) colors = themeColors(palette).colors;
    } catch (err) {
      console.error(err);
    }
  }
  if (ticket !== generation) return;
  setPaletteColors(colors);
  await ensureTransparentSurfaces(context);
}

// ---------------------------------------------------------------- the theme under the palette

type ThemeContribution = { id?: string; label?: string; uiTheme?: string };

const themesOf = (extensionId: string): ThemeContribution[] => vscode.extensions.getExtension(extensionId)?.packageJSON?.contributes?.themes ?? [];

/** Whether a workbench.colorTheme value is one of Doki's themes. */
function isDokiTheme(name: string | undefined): boolean {
  return !!name && themesOf(DOKI_ID).some((t) => t.id === name || t.label === name);
}

/**
 * VS Code's own dark theme: its default one when that is dark (Dark 2026, Dark Modern, … by
 * version), else the first dark theme it ships with. The palette gives it its hues; its syntax
 * colors are made for dark backgrounds, like wallpapers darkened behind code.
 */
function builtInDarkTheme(): { name: string; isDefault: boolean } {
  const workbench = vscode.workspace.getConfiguration("workbench");
  const builtIn = themesOf("vscode.theme-defaults");
  const byName = (name: string | undefined) => builtIn.find((t) => (t.id ?? t.label) === name);
  const fallback = workbench.inspect<string>("colorTheme")?.defaultValue;
  if (fallback && byName(fallback)?.uiTheme === "vs-dark") return { name: fallback, isDefault: true };
  const dark = builtIn.find((t) => t.uiTheme === "vs-dark");
  return { name: dark?.id ?? dark?.label ?? "Default Dark Modern", isDefault: false };
}

/** Ask first, then switch to VS Code's dark theme and turn the option on. Returns whether it did. */
export async function enablePaletteTheme(): Promise<boolean> {
  // No image, no palette (the panel's box is greyed out then; this covers other ways in).
  if (!sourceImage()) {
    const source = carouselConfig().get<string>("paletteSource", "wallpaper") === "background" ? "background" : "wallpaper";
    vscode.window.showInformationMessage(`Apply a ${source} first: Theme from wallpaper takes its colors from it.`);
    return false;
  }
  const workbench = vscode.workspace.getConfiguration("workbench");
  const current = workbench.get<string>("colorTheme") ?? "";
  const dark = builtInDarkTheme();
  const replaced = current && current !== dark.name ? `your current theme (${current}) is replaced by` : "VS Code uses";
  const choice = await vscode.window.showWarningMessage(
    "Color VS Code with the wallpaper's palette?",
    {
      modal: true,
      detail: [
        "VS Code's colors will come from the colors of your wallpaper, and follow it each time you change it.",
        `So that Doki's colors don't mix with them, ${replaced} VS Code's own dark theme (${dark.name}). Doki's wallpapers and stickers stay.`,
        "Don't switch to a Doki theme while this is on: both would color VS Code at once.",
        "To go back to VS Code's own theme, untick the box, or remove the wallpaper: without one there is no palette. A Doki theme can be picked again with Preferences: Color Theme.",
      ].join("\n\n"),
    },
    "Use Wallpaper Colors"
  );
  if (!choice) return false;
  if (current !== dark.name) {
    // The default theme is VS Code's when no value is set; another dark one has to be named.
    await workbench.update("colorTheme", dark.isDefault ? undefined : dark.name, vscode.ConfigurationTarget.Global);
    if (workbench.inspect<string>("colorTheme")?.workspaceValue !== undefined) {
      await workbench.update("colorTheme", dark.name, vscode.ConfigurationTarget.Workspace);
    }
  }
  await carouselConfig().update("wallpaperTheme", true, vscode.ConfigurationTarget.Global);
  return true;
}

export async function disablePaletteTheme() {
  await carouselConfig().update("wallpaperTheme", false, vscode.ConfigurationTarget.Global);
}

/** A Doki theme picked while the option is on: both would color VS Code at once. */
export async function checkThemeConflict() {
  if (!isPaletteThemeOn() || !vscode.window.state.focused) return;
  if (!isDokiTheme(vscode.workspace.getConfiguration("workbench").get<string>("colorTheme"))) return;
  const choice = await vscode.window.showWarningMessage(
    "A Doki theme is active while Theme from wallpaper is on, so both color VS Code at once. Turn Theme from wallpaper off to use the Doki theme as it is.",
    "Turn Off Theme from Wallpaper"
  );
  if (choice) await disablePaletteTheme();
}
