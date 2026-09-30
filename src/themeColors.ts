import { Lab, PaletteColor, labToRgb, rgbToLab } from "./palette";

// Theme colors from a wallpaper's palette, laid over VS Code's own dark theme through
// workbench.colorCustomizations. The code and the side bars sit on the wallpaper, which people
// darken to read over it, so the theme is always a dark one: the palette gives it its hues. Every
// text color is checked for contrast (WCAG), and moved in lightness until it reads well.
// No vscode import: it can be tried with plain Node.

type Lch = [number, number, number];

const toLch = ([l, a, b]: Lab): Lch => [l, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
const fromLch = ([l, c, h]: Lch): Lab => [l, c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180)];

function hex(lch: Lch, alpha?: number): string {
  const rgb = labToRgb(fromLch(lch));
  const a = alpha === undefined ? "" : Math.round(alpha * 255).toString(16).padStart(2, "0");
  return "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("") + a;
}

/** WCAG relative luminance of an LCh color, as it ends up in sRGB. */
function luminance(lch: Lch): number {
  const [r, g, b] = labToRgb(fromLch(lch)).map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Lch, b: Lch): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The same hue, lighter until it reaches `ratio` against `background` (or white). */
function readableOn(color: Lch, background: Lch, ratio: number): Lch {
  let [l, c, h] = color;
  while (l < 98 && contrast([l, c, h], background) < ratio) {
    l += 2;
    c *= 0.97; // very light colors can't stay as saturated
  }
  return [Math.min(l, 98), c, h];
}

const hueDistance = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

export interface ThemePalette {
  surface: string;
  accent: string;
  secondary: string;
  text: string;
}

/**
 * The roles: the surfaces take the hue of the wallpaper's main color, the accent is its most
 * colorful color that covers a fair part of it, and the secondary a colorful one of another hue.
 */
function roles(palette: PaletteColor[]) {
  const colors = palette.map((p) => ({ lch: toLch(rgbToLab(p.rgb)), weight: p.weight }));
  const main = colors[0].lch;
  // Specks (under 2 %) don't set the mood of a wallpaper.
  const colorful = colors.filter((c) => c.lch[1] >= 15 && c.weight >= 0.02).sort((a, b) => b.lch[1] * Math.sqrt(b.weight) - a.lch[1] * Math.sqrt(a.weight));
  // A gray wallpaper: a soft accent in the main hue, or a calm blue when there is no hue at all.
  const accentHue = colorful[0]?.lch[2] ?? (main[1] >= 4 ? main[2] : 230);
  const accentChroma = colorful[0] ? Math.min(colorful[0].lch[1], 85) : 30;
  const other = colorful.find((c) => hueDistance(c.lch[2], accentHue) >= 40);
  const secondaryHue = other?.lch[2] ?? (accentHue + 35) % 360;
  const secondaryChroma = other ? Math.min(other.lch[1], 75) : accentChroma * 0.8;
  // Main colors without a real hue (black, gray) tint the surfaces with the accent, faintly.
  const surfaceHue = main[1] >= 4 ? main[2] : accentHue;
  const surfaceChroma = Math.min(Math.max(main[1], 3), 10);
  return { accentHue, accentChroma, secondaryHue, secondaryChroma, surfaceHue, surfaceChroma };
}

/** Theme colors for workbench.colorCustomizations, from the wallpaper's palette. */
export function themeColors(palette: PaletteColor[]): { colors: Record<string, string>; palette: ThemePalette } {
  const r = roles(palette);
  const surface: Lch = [10, r.surfaceChroma, r.surfaceHue];
  const surface2: Lch = [15, r.surfaceChroma, r.surfaceHue];
  const surface3: Lch = [22, r.surfaceChroma * 0.9, r.surfaceHue];
  const text = readableOn([90, 5, r.surfaceHue], surface2, 7);
  const muted = readableOn([66, 6, r.surfaceHue], surface2, 4.5);
  // Accents bright enough to read as text and borders on the dark surfaces.
  const accent = readableOn([60, r.accentChroma, r.accentHue], surface2, 4.5);
  const accentHover: Lch = [Math.min(accent[0] + 8, 95), accent[1], accent[2]];
  const secondary = readableOn([62, r.secondaryChroma, r.secondaryHue], surface2, 4.5);
  // Text on an accent fill: white or near black, whichever reads better.
  const white: Lch = [100, 0, 0];
  const black: Lch = [8, 0, 0];
  const onAccent = contrast(white, accent) >= contrast(black, accent) ? white : black;

  const s = hex(surface);
  const s2 = hex(surface2);
  const s3 = hex(surface3);
  const t = hex(text);
  const m = hex(muted);
  const a = hex(accent);
  const on = hex(onAccent);
  const colors: Record<string, string> = {
    // general
    foreground: t,
    descriptionForeground: m,
    "icon.foreground": m,
    focusBorder: a,
    "selection.background": hex(accent, 0.4),
    "widget.shadow": "#00000080",
    "textLink.foreground": a,
    "textLink.activeForeground": hex(accentHover),
    "progressBar.background": a,
    // buttons and badges
    "button.background": a,
    "button.foreground": on,
    "button.hoverBackground": hex(accentHover),
    "button.secondaryBackground": s3,
    "button.secondaryForeground": t,
    "badge.background": a,
    "badge.foreground": on,
    // activity bar, title bar, status bar
    "activityBar.background": s,
    "activityBar.foreground": t,
    "activityBar.inactiveForeground": m,
    "activityBar.activeBorder": a,
    "activityBarBadge.background": a,
    "activityBarBadge.foreground": on,
    "titleBar.activeBackground": s,
    "titleBar.activeForeground": t,
    "titleBar.inactiveBackground": s,
    "titleBar.inactiveForeground": m,
    "statusBar.background": s,
    "statusBar.foreground": t,
    "statusBar.noFolderBackground": s,
    "statusBar.debuggingBackground": hex(secondary),
    "statusBar.debuggingForeground": contrast(white, secondary) >= contrast(black, secondary) ? "#ffffff" : hex(black),
    "statusBarItem.remoteBackground": a,
    "statusBarItem.remoteForeground": on,
    // tabs and panels
    "editorGroupHeader.tabsBackground": s,
    "tab.activeBackground": s2,
    "tab.inactiveBackground": s,
    "tab.activeForeground": t,
    "tab.inactiveForeground": m,
    "tab.activeBorderTop": a,
    "panelTitle.activeBorder": a,
    "panelTitle.activeForeground": t,
    "panelTitle.inactiveForeground": m,
    "sideBarTitle.foreground": t,
    "sideBarSectionHeader.foreground": t,
    // editor
    "editor.foreground": t,
    "editorCursor.foreground": a,
    "editor.selectionBackground": hex(accent, 0.33),
    "editor.selectionHighlightBackground": hex(accent, 0.15),
    "editor.findMatchBackground": hex(secondary, 0.45),
    "editor.findMatchHighlightBackground": hex(secondary, 0.22),
    "editorLineNumber.foreground": hex(muted, 0.6),
    "editorLineNumber.activeForeground": a,
    "editorBracketMatch.border": a,
    "terminalCursor.foreground": a,
    // lists and trees
    "list.activeSelectionBackground": hex(accent, 0.3),
    "list.activeSelectionForeground": t,
    "list.inactiveSelectionBackground": hex(accent, 0.15),
    "list.hoverBackground": hex(text, 0.08),
    "list.highlightForeground": a,
    "list.focusOutline": a,
    // inputs, menus and floating widgets
    "input.background": s2,
    "input.foreground": t,
    "input.border": s3,
    "inputOption.activeBorder": a,
    "dropdown.background": s2,
    "dropdown.foreground": t,
    "dropdown.border": s3,
    "menu.background": s2,
    "menu.foreground": t,
    "menu.selectionBackground": hex(accent, 0.3),
    "editorWidget.background": s2,
    "editorHoverWidget.background": s2,
    "editorSuggestWidget.background": s2,
    "editorSuggestWidget.selectedBackground": hex(accent, 0.3),
    "notifications.background": s2,
    "scrollbarSlider.background": hex(text, 0.15),
    "scrollbarSlider.hoverBackground": hex(text, 0.25),
    "scrollbarSlider.activeBackground": hex(accent, 0.5),
  };
  return { colors, palette: { surface: s, accent: a, secondary: hex(secondary), text: t } };
}

/** Every color key a palette sets: the same for every wallpaper. */
export const PALETTE_KEYS = Object.keys(themeColors([{ rgb: [0, 0, 0], weight: 1 }]).colors);
