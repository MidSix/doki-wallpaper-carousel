import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// Doki paints the wallpaper as a background image with `!important` on the editor and terminal
// elements themselves, so no theme color can cover it there. To hide it in one of those areas,
// a small CSS block of ours goes into the same VS Code stylesheet Doki writes to.
// No vscode import: the uninstall script (uninstall.ts) uses this too.

const START = "/* Wallpaper Carousel for Doki Theme: start */";
const END = "/* Wallpaper Carousel for Doki Theme: end */";

// Doki cuts its sections out from these comments to the next one (or to the end of the file)
// before writing them again (Doki's StickerService). Placed before all of them, our block is kept.
const DOKI_MARKERS = ["/* Stickers */", "/* Hide Watermark */", "/* Background Image */", "/* EmptyEditor Image */"];

// Elements that get the wallpaper in Doki's CSS, in the editor area (code, Welcome page,
// Settings, tabs) and in the terminal. The editor area's own content box is left out: with no
// file open it shows Doki's other image, the background, which has a setting of its own.
const EDITOR_SELECTORS = [
  ".overflow-guard",
  ".monaco-scrollable-element::before",
  ".editor-container",
  ".tab",
  ".tabs-container",
  ".monaco-breadcrumbs",
  ".breadcrumbs-control",
  ".editor-actions",
  ".minimap-decorations-layer",
  ".decorationsOverviewRuler",
  ".sticky-line-content",
  ".sticky-line-number",
  ".monaco-tree-sticky-row",
  ".settings-toc-container",
  "button.getting-started-category",
  "div.header",
  "> .content .content",
  ".monaco-select-box",
  ".ref-tree",
  ".head",
  ".welcomePageFocusElement",
  ".monaco-pane-view",
  ".pane-header",
  ".composite.title",
];
const TERMINAL_SELECTORS = [".terminal .xterm", ".terminal-wrapper", ".xterm .xterm-screen canvas", ".xterm-cursor-layer"];

export interface Overrides {
  /** Show the wallpaper in the editor area. */
  editor: boolean;
  /** Show the wallpaper in the terminal. */
  terminal: boolean;
}

// Doki's rules use classes only; `:not(#dc)` adds the weight of an id, so ours win over them.
function hide(scope: string, selectors: string[]): string {
  const list = selectors.map((s) => {
    const [element, pseudo] = s.split("::");
    return `${scope} ${element}:not(#dc)${pseudo ? `::${pseudo}` : ""}`;
  });
  return `${list.join(",\n")} {\n  background-image: none !important;\n}`;
}

/** Our CSS block for these settings; empty when the wallpaper is shown everywhere. */
export function overridesCss(o: Overrides): string {
  const rules: string[] = [];
  if (!o.editor) {
    rules.push(hide(".monaco-workbench .part.editor", EDITOR_SELECTORS));
    // See-through parts of an open editor (the breadcrumbs bar) would now show the background of
    // the empty editor area behind them, so a group with editors open gets a solid fill.
    rules.push(`.monaco-workbench .part.editor .editor-group-container:not(.empty):not(#dc) {\n  background-color: var(--vscode-editor-background) !important;\n}`);
  }
  if (!o.terminal) rules.push(hide(".monaco-workbench", TERMINAL_SELECTORS));
  return rules.length ? `${START}\n${rules.join("\n")}\n${END}` : "";
}

/** The stylesheet without our block, exactly as it was before it was added. */
export function withoutOverrides(css: string): string {
  let start = css.indexOf(START);
  if (start === -1) return css;
  const endMarker = css.indexOf(END, start);
  if (endMarker === -1) return css;
  let end = endMarker + END.length;
  // The line breaks added around the block (withOverrides) go with it.
  if (css[start - 1] === "\n") start--;
  if (css[end] === "\n") end++;
  return css.slice(0, start) + css.slice(end);
}

/** The stylesheet with `block` in place of ours (none when empty), before Doki's sections. */
export function withOverrides(css: string, block: string): string {
  const clean = withoutOverrides(css);
  if (!block) return clean;
  const markers = DOKI_MARKERS.map((m) => clean.indexOf(m)).filter((i) => i !== -1);
  const at = markers.length ? Math.min(...markers) : clean.length;
  return `${clean.slice(0, at)}\n${block}\n${clean.slice(at)}`;
}

export function hasOverrides(cssFile: string): boolean {
  try {
    return fs.readFileSync(cssFile, "utf-8").includes(START);
  } catch {
    return false;
  }
}

/**
 * VS Code keeps a checksum of its stylesheet in product.json and reports the installation as
 * corrupt when the file no longer matches. Same fix as Doki's CheckSumService: update the checksum,
 * after keeping the untouched product.json as product.json.orig.<version> if Doki hasn't yet.
 */
export function fixChecksum(cssFile: string) {
  const outDir = path.resolve(path.dirname(cssFile), "..", "..");
  const productFile = path.join(path.dirname(outDir), "product.json");
  if (!fs.existsSync(productFile)) return;
  const product = JSON.parse(fs.readFileSync(productFile, "utf-8"));
  const key = path.relative(outDir, cssFile).split(path.sep).join("/");
  if (!product.checksums || !(key in product.checksums)) return;
  const checksum = crypto.createHash("sha256").update(fs.readFileSync(cssFile)).digest("base64").replace(/=+$/, "");
  if (product.checksums[key] === checksum) return;
  const backup = `${productFile}.orig.${product.version}`;
  if (!fs.existsSync(backup)) fs.copyFileSync(productFile, backup);
  product.checksums[key] = checksum;
  fs.writeFileSync(productFile, JSON.stringify(product, null, "\t"), "utf-8");
}

/** Write `block` into the stylesheet (empty = remove ours). Returns whether the file changed. */
export function applyOverrides(cssFile: string, block: string): boolean {
  const css = fs.readFileSync(cssFile, "utf-8");
  const next = withOverrides(css, block);
  if (next === css) return false;
  fs.writeFileSync(cssFile, next, "utf-8");
  fixChecksum(cssFile);
  return true;
}

/**
 * Stylesheets that got our CSS block, kept in the extension's own folder: the uninstall script
 * runs without the vscode API and can only find files next to itself.
 */
export const PATCHED_LIST = path.join(__dirname, "..", "patched-css.json");

export function rememberPatched(cssFile: string) {
  let files: string[] = [];
  try {
    files = JSON.parse(fs.readFileSync(PATCHED_LIST, "utf-8"));
  } catch {
    // First one.
  }
  if (files.includes(cssFile)) return;
  try {
    fs.writeFileSync(PATCHED_LIST, JSON.stringify([...files, cssFile]));
  } catch {
    // A read-only extensions folder: the block then stays until VS Code updates.
  }
}
