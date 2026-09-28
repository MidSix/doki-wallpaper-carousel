import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { applyOverrides, overridesCss, rememberPatched } from "./cssOverrides";
import { SwitchProgress, SwitchSteps } from "./switchProgress";

// Doki's own ConfigWatcher listens to these settings: when one of them changes to an
// existing file, Doki rewrites VS Code's workbench CSS. We only change the setting.
const DOKI_SECTION = "doki";
const WALLPAPER_KEY = "wallpaper.path";
const BACKGROUND_KEY = "background.path";
// Doki's on/off switch for each image, and the comment that starts its section in the CSS.
const ENABLED_KEY: Record<string, string> = { [WALLPAPER_KEY]: "wallpaper.enabled", [BACKGROUND_KEY]: "background.enabled" };
const CSS_MARKER: Record<string, string> = { [WALLPAPER_KEY]: "/* Background Image */", [BACKGROUND_KEY]: "/* EmptyEditor Image */" };

type Target = "wallpaper" | "background" | "both";

function carouselConfig() {
  return vscode.workspace.getConfiguration("dokiCarousel");
}

function targetKeys(): string[] {
  const target = carouselConfig().get<Target>("target", "wallpaper");
  if (target === "background") return [BACKGROUND_KEY];
  if (target === "both") return [WALLPAPER_KEY, BACKGROUND_KEY];
  return [WALLPAPER_KEY];
}

/** Path currently configured in Doki for the carousel's target. */
export function getCurrentDokiPath(): string | undefined {
  const value = vscode.workspace.getConfiguration(DOKI_SECTION).get<string>(targetKeys()[0]);
  // Normalized: a file reinstalled after Set opacity is set as "dir/./name" (see applyWallpaper).
  return value ? path.normalize(value) : undefined;
}

/** Whether Doki shows an image for the carousel's target: a path is set and Doki's switch is on. */
export function isWallpaperShown(): boolean {
  const doki = vscode.workspace.getConfiguration(DOKI_SECTION);
  return targetKeys().some((key) => !!doki.get<string>(key) && doki.get<boolean>(ENABLED_KEY[key], true));
}

// Same file Doki writes to (see Doki's ENV.ts).
function workbenchCssPath(): string | undefined {
  const dir = path.join(vscode.env.appRoot, "out", "vs", "workbench");
  for (const name of ["workbench.desktop.main.css", "workbench.web.main.css"]) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function mtime(file: string | undefined): number {
  try {
    return file ? fs.statSync(file).mtimeMs : 0;
  } catch {
    return 0;
  }
}

// Doki embeds the image in the CSS as `data:image/<ext>;base64,...`. The base64 of the
// first 3000 bytes (a multiple of 3) is an exact prefix of the whole file's base64.
function imageSignature(imagePath: string): string {
  const fd = fs.openSync(imagePath, "r");
  try {
    const buffer = Buffer.alloc(3000);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return "base64," + buffer.subarray(0, read - (read % 3)).toString("base64");
  } finally {
    fs.closeSync(fd);
  }
}

function cssContains(css: string, signature: string): boolean {
  try {
    return fs.readFileSync(css, "utf-8").includes(signature);
  } catch {
    return false;
  }
}

function readCss(css: string): string {
  try {
    return fs.readFileSync(css, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Wait until Doki has written a CSS for which `done` holds. With `rewrite`, only a CSS written
 * after this call counts, not the one already there.
 */
async function waitForCss(css: string | undefined, done: (text: string) => boolean, timeoutMs: number, rewrite = false): Promise<boolean> {
  if (!css) return false;
  if (!rewrite && done(readCss(css))) return true;
  let last = mtime(css);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 250));
    const now = mtime(css);
    if (now !== last) {
      last = now;
      if (done(readCss(css))) return true;
    }
  }
  return false;
}

/**
 * The same file under another name: "dir/./name". Doki only reinstalls when the text of its
 * setting changes, so this makes it pick up a file whose content changed (Set opacity).
 */
function otherSpelling(file: string): string {
  return `${path.dirname(file)}${path.sep}.${path.sep}${path.basename(file)}`;
}

// Write where the value is actually defined: a workspace value overrides the global one,
// so updating only the global setting would leave Doki's effective path unchanged.
function scopeFor(config: vscode.WorkspaceConfiguration, key: string): vscode.ConfigurationTarget {
  const info = config.inspect(key);
  if (info?.workspaceFolderValue !== undefined || info?.workspaceValue !== undefined) {
    return vscode.ConfigurationTarget.Workspace;
  }
  return vscode.ConfigurationTarget.Global;
}

// Installed (non-dev) VS Code serves vscode-file:// resources without no-store headers,
// so "Reload Window" reuses the old workbench CSS from the renderer's cache. A brand-new
// window gets its own renderer process and reads the CSS Doki just wrote.
async function reopenWindow() {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const windowConfig = vscode.workspace.getConfiguration("window");
  const maximize = carouselConfig().get<boolean>("maximize", true);
  const previousDimensions = windowConfig.inspect<string>("newWindowDimensions")?.globalValue;

  // The main process decides the size of a window when it creates it, so ask for a
  // maximized window instead of resizing it afterwards.
  if (maximize) {
    await windowConfig.update("newWindowDimensions", "maximized", vscode.ConfigurationTarget.Global);
    await sleep(500); // let the main process pick up the settings change
  }

  const hasWorkspace = !!vscode.workspace.workspaceFile || !!vscode.workspace.workspaceFolders?.length;
  await vscode.commands.executeCommand(hasWorkspace ? "workbench.action.duplicateWorkspaceInNewWindow" : "workbench.action.newWindow");
  await sleep(1500);

  if (maximize) {
    await windowConfig.update("newWindowDimensions", previousDimensions, vscode.ConfigurationTarget.Global);
  }
  await vscode.commands.executeCommand("workbench.action.closeWindow");
}

/**
 * Doki gives every terminal canvas the wallpaper as background. With the GPU renderer the
 * transparent layers stacked over the text canvas become opaque and hide the text; the DOM
 * renderer draws text as HTML, so it stays readable.
 */
export async function ensureTerminalReadable() {
  if (!carouselConfig().get<boolean>("fixTerminalText", true)) return;
  const terminal = vscode.workspace.getConfiguration("terminal.integrated");
  if (terminal.get<string>("gpuAcceleration") === "off") return;
  await terminal.update("gpuAcceleration", "off", scopeFor(terminal, "gpuAcceleration"));
}

const TRANSPARENT = "#00000000";

/** Strip the comments and trailing commas a theme file may have (JSON with comments). */
function parseJsonc(text: string): any {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i === -1) break;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function readThemeColors(file: string, depth = 0): Record<string, string> {
  try {
    const theme = parseJsonc(fs.readFileSync(file, "utf-8"));
    const base = typeof theme.include === "string" && depth < 5 ? readThemeColors(path.join(path.dirname(file), theme.include), depth + 1) : {};
    return { ...base, ...(theme.colors ?? {}) };
  } catch {
    return {};
  }
}

/** Colors of the active theme as its file defines them, before any colorCustomizations. */
function activeThemeColors(): Record<string, string> {
  const id = vscode.workspace.getConfiguration("workbench").get<string>("colorTheme");
  for (const ext of vscode.extensions.all) {
    const themes: { id?: string; label?: string; path?: string }[] = ext.packageJSON?.contributes?.themes ?? [];
    const theme = themes.find((t) => (t.id ?? t.label) === id);
    if (theme?.path) return readThemeColors(path.join(ext.extensionPath, theme.path));
  }
  return {};
}

/**
 * Background for a terminal without the wallpaper. Themes rarely define terminal.background, and
 * VS Code then uses the panel's color, which is transparent while the panel shows the wallpaper.
 */
function opaqueTerminalColor(): string {
  const colors = activeThemeColors();
  const color = colors["terminal.background"] ?? colors["panel.background"] ?? colors["editor.background"];
  if (color) return color;
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? "#ffffff" : "#1e1e1e";
}

/**
 * Doki paints the wallpaper on the containers of the editor, side bars and panel, but newer
 * VS Code versions fill the views on top of them with opaque theme colors. Making those
 * colors transparent in workbench.colorCustomizations lets the wallpaper show through.
 * Returns the color overrides wanted by the current settings (undefined = leave the theme's)
 * and the keys whose color only fills in when the user has none of their own.
 */
function wantedColors(): { colors: Record<string, string | undefined>; fallbacks: Set<string> } {
  const cfg = carouselConfig();
  const terminalWallpaper = cfg.get<boolean>("transparentTerminal", true);
  const panels = cfg.get<boolean>("transparentPanels", true) ? TRANSPARENT : undefined;
  const tint = Math.min(100, Math.max(0, cfg.get<number>("quickInputTint", 65)));
  const quickInput = "#000000" + Math.round((tint / 100) * 255).toString(16).padStart(2, "0");
  return {
    colors: {
      // Covers Doki's wallpaper on the terminal when it is switched off (see opaqueTerminalColor).
      "terminal.background": terminalWallpaper ? TRANSPARENT : opaqueTerminalColor(),
      "sideBar.background": panels, // left side bar and right (auxiliary) side bar
      "sideBarSectionHeader.background": panels,
      "panel.background": panels, // bottom panel, including the terminal tabs list
      // The command palette floats over the editor with Doki's blur behind it; a translucent
      // tint keeps its text readable while the wallpaper still shows through.
      "quickInput.background": quickInput,
    },
    fallbacks: new Set(terminalWallpaper ? [] : ["terminal.background"]),
  };
}

const OWNED_COLORS_KEY = "dokiCarousel.ownedColors";

export async function ensureTransparentSurfaces(context: vscode.ExtensionContext) {
  const workbench = vscode.workspace.getConfiguration("workbench");
  const current = workbench.inspect<Record<string, unknown>>("colorCustomizations")?.globalValue ?? {};
  // Values we wrote earlier: only these are ever removed, never the user's own colors.
  const owned = context.globalState.get<Record<string, string>>(OWNED_COLORS_KEY, {});

  const next: Record<string, unknown> = { ...current };
  const nextOwned: Record<string, string> = {};
  const { colors, fallbacks } = wantedColors();
  for (const [key, value] of Object.entries(colors)) {
    const usersOwn = current[key] !== undefined && current[key] !== owned[key];
    if (fallbacks.has(key) && usersOwn) continue;
    if (value !== undefined) {
      next[key] = value;
      nextOwned[key] = value;
    } else if (owned[key] !== undefined && current[key] === owned[key]) {
      delete next[key];
    }
  }

  await context.globalState.update(OWNED_COLORS_KEY, nextOwned);
  if (JSON.stringify(next) !== JSON.stringify(current)) {
    await workbench.update("colorCustomizations", next, vscode.ConfigurationTarget.Global);
  }
}

/**
 * Put our CSS block (see cssOverrides.ts) in VS Code's stylesheet, or take it out, to match the
 * settings. A window shows the file as it was when the window opened, so a change needs a reopen.
 */
export function ensureCssOverrides(): "changed" | "unchanged" | "failed" {
  const css = workbenchCssPath();
  if (!css) return "failed";
  const cfg = carouselConfig();
  const block = overridesCss({ editor: cfg.get<boolean>("wallpaperInEditor", true), terminal: cfg.get<boolean>("transparentTerminal", true) });
  try {
    const changed = applyOverrides(css, block);
    if (block) rememberPatched(css);
    return changed ? "changed" : "unchanged";
  } catch (err) {
    vscode.window.showErrorMessage(`Could not update VS Code's stylesheet (it must be writable, as for Doki's wallpapers): ${err}`);
    return "failed";
  }
}

// ---------------------------------------------------------------- switching lock

// One switch at a time per window: every extra click would otherwise open one more window.
// The lock lives in this window's extension host, so the new window starts unlocked.
let switching = false;
const switchingEmitter = new vscode.EventEmitter<boolean>();
export const onDidChangeSwitching = switchingEmitter.event;
export const isSwitching = () => switching;

function setSwitching(value: boolean) {
  if (switching === value) return;
  switching = value;
  switchingEmitter.fire(value);
}

// Fallback: if this window is still open this long after asking it to close, unlock it.
const COOLDOWN_MS = 6000;
const SETTLE_MS = 400;
const INSTALL_MS_KEY = "dokiCarousel.installMs";
let store: vscode.Memento | undefined;

/** Lets the progress bar learn how long Doki usually takes on this machine. */
export function initSwitching(context: vscode.ExtensionContext) {
  store = context.globalState;
}

let busyMessage: vscode.Disposable | undefined;
function reportBusy(text = "A wallpaper is already being applied…") {
  busyMessage?.dispose();
  busyMessage = vscode.window.setStatusBarMessage(`$(sync~spin) ${text}`, 3000);
}

// ---------------------------------------------------------------- file task lock

// Switching closes this window, and with it the extension host that runs the file tools:
// a copy, move or conversion would stop halfway. So no switching while one of them runs,
// and no new task while a switch is under way.
const tasks = new Map<number, string>();
let nextTaskId = 0;
const taskEmitter = new vscode.EventEmitter<string | undefined>();
export const onDidChangeTask = taskEmitter.event;
/** Label of the file task running in this window, if any. */
export const currentTask = (): string | undefined => tasks.values().next().value;

/** Mark a file task as running until the returned lock is disposed; undefined while switching. */
export function beginTask(label: string): vscode.Disposable | undefined {
  if (switching) {
    reportBusy("A wallpaper is being applied, try again once the window has reopened.");
    return undefined;
  }
  const id = nextTaskId++;
  tasks.set(id, label);
  taskEmitter.fire(currentTask());
  return new vscode.Disposable(() => {
    if (tasks.delete(id)) taskEmitter.fire(currentTask());
  });
}

function createProgress(steps: Omit<SwitchSteps, "reopen">): SwitchProgress {
  const maximize = carouselConfig().get<boolean>("maximize", true);
  // Matches the waits in reopenWindow(), plus a moment for the window to close.
  const reopenMs = SETTLE_MS + (maximize ? 500 : 0) + 1500 + 300;
  return new SwitchProgress({ ...steps, reopen: "Open a new window" }, store?.get<number>(INSTALL_MS_KEY, 2500) ?? 2500, reopenMs);
}

const wallpaperSteps = (imagePath: string): Omit<SwitchSteps, "reopen"> => ({
  title: `Applying wallpaper: ${path.basename(imagePath)}`,
  placeholder: "Please wait, the window will reopen with the new wallpaper",
  save: "Save the new wallpaper path",
  install: "Doki installs the wallpaper",
});

/** Reopen the window so it loads the stylesheet changed by ensureCssOverrides(). */
export async function reopenToApply(change: string) {
  if (switching) return; // the window is about to reopen anyway
  const task = currentTask();
  if (task) {
    vscode.window.showInformationMessage(`${change}: ${task.toLowerCase()} in progress, so the change will show the next time the window reopens.`);
    return;
  }
  setSwitching(true);
  const progress = createProgress({
    title: change,
    placeholder: "Please wait, the window will reopen with the change",
    save: "Save the setting",
    install: "Update VS Code's stylesheet",
  });
  await refreshAndRelease(progress);
}

/** Refresh the window, keeping the lock until the window goes away or the cooldown ends. */
async function refreshAndRelease(progress: SwitchProgress) {
  progress.setStage("reopen");
  try {
    await new Promise((r) => setTimeout(r, SETTLE_MS)); // let Doki finish fixing checksums
    await reopenWindow();
  } catch (err) {
    console.error(err);
  }
  setTimeout(() => {
    progress.dispose();
    setSwitching(false);
    vscode.window.setStatusBarMessage("$(warning) The window did not reopen. You can try again.", 5000);
  }, COOLDOWN_MS);
}

/** Point Doki to a new image and refresh the window once Doki has installed it. */
export async function applyWallpaper(imagePath: string): Promise<void> {
  if (switching) return reportBusy();
  const task = currentTask();
  if (task) {
    vscode.window.showWarningMessage(`${task} in progress. You can change the wallpaper once it finishes.`);
    return;
  }
  if (!fs.existsSync(imagePath)) {
    vscode.window.showErrorMessage(`File not found: ${imagePath}`);
    return;
  }

  setSwitching(true);
  const progress = createProgress(wallpaperSteps(imagePath));
  let installed = false;
  try {
    const css = workbenchCssPath();
    const signature = imageSignature(imagePath);
    const doki = vscode.workspace.getConfiguration(DOKI_SECTION);
    // Applying a wallpaper means showing it, also after Remove wallpaper turned Doki's switch off.
    let switchedOn = false;
    for (const key of targetKeys()) {
      if (!doki.get<boolean>(ENABLED_KEY[key], true)) {
        await doki.update(ENABLED_KEY[key], true, scopeFor(doki, ENABLED_KEY[key]));
        switchedOn = true;
      }
    }
    // Doki reinstalls only when the path setting changes. The same path needs another spelling
    // when its content isn't installed yet (the file was replaced) or a switch was just turned on.
    const rewrite = switchedOn || (!!css && !cssContains(css, signature));
    for (const key of targetKeys()) {
      const value = rewrite && doki.get<string>(key) === imagePath ? otherSpelling(imagePath) : imagePath;
      await doki.update(key, value, scopeFor(doki, key));
    }

    // Doki checks its remote assets before writing, which can take a while on a slow network.
    progress.setStage("install");
    const started = Date.now();
    installed = await waitForCss(css, (text) => text.includes(signature), 30000, switchedOn);
    const took = Date.now() - started;
    // Skip instant hits (the image was already installed); they say nothing about Doki's speed.
    if (installed && took > 300) {
      const previous = store?.get<number>(INSTALL_MS_KEY);
      await store?.update(INSTALL_MS_KEY, Math.round(previous ? previous * 0.6 + took * 0.4 : took));
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Could not apply the wallpaper: ${err}`);
    return;
  } finally {
    if (!installed) {
      progress.dispose();
      setSwitching(false);
    }
  }

  if (installed) {
    await refreshAndRelease(progress);
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Wallpaper set to ${path.basename(imagePath)}, but Doki did not update the CSS yet. Is a Doki theme active?`,
    "Refresh Window"
  );
  if (choice && !switching && !currentTask()) {
    setSwitching(true);
    await refreshAndRelease(createProgress(wallpaperSteps(imagePath)));
  }
}

/**
 * Take the carousel's image out of VS Code but keep Doki's stickers. Doki's own "Remove
 * Sticker/Background" removes the stickers too; instead, Doki's switch for the image is turned
 * off and its path cleared, and Doki rewrites its CSS without it. Applying a wallpaper turns the
 * switch back on.
 */
export async function removeWallpaper(): Promise<void> {
  if (switching) return reportBusy();
  const task = currentTask();
  if (task) {
    vscode.window.showWarningMessage(`${task} in progress. You can remove the wallpaper once it finishes.`);
    return;
  }
  const doki = vscode.workspace.getConfiguration(DOKI_SECTION);
  const keys = targetKeys().filter((key) => !!doki.get<string>(key) && doki.get<boolean>(ENABLED_KEY[key], true));
  if (!keys.length) {
    vscode.window.showInformationMessage("No wallpaper is set.");
    return;
  }

  setSwitching(true);
  const progress = createProgress({
    title: "Removing the wallpaper",
    placeholder: "Please wait, the window will reopen without the wallpaper",
    save: "Turn off Doki's wallpaper",
    install: "Doki removes it from VS Code",
  });
  let removed = false;
  try {
    for (const key of keys) await doki.update(ENABLED_KEY[key], false, scopeFor(doki, ENABLED_KEY[key]));
    // Clearing the path is what makes Doki rewrite its CSS, now with the switch off.
    for (const key of keys) await doki.update(key, undefined, scopeFor(doki, key));
    progress.setStage("install");
    removed = await waitForCss(workbenchCssPath(), (text) => keys.every((key) => !text.includes(CSS_MARKER[key])), 30000, true);
  } catch (err) {
    vscode.window.showErrorMessage(`Could not remove the wallpaper: ${err}`);
  } finally {
    if (!removed) {
      progress.dispose();
      setSwitching(false);
    }
  }
  if (removed) await refreshAndRelease(progress);
  else vscode.window.showWarningMessage("Doki did not remove the wallpaper from VS Code yet. Is a Doki theme active?");
}
