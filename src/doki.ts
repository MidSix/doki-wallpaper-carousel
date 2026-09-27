import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { SwitchProgress } from "./switchProgress";

// Doki's own ConfigWatcher listens to these settings: when one of them changes to an
// existing file, Doki rewrites VS Code's workbench CSS. We only change the setting.
const DOKI_SECTION = "doki";
const WALLPAPER_KEY = "wallpaper.path";
const BACKGROUND_KEY = "background.path";

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
  return vscode.workspace.getConfiguration(DOKI_SECTION).get<string>(targetKeys()[0]) || undefined;
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

/** Wait until Doki has written a CSS that contains the image. */
async function waitForInstall(css: string | undefined, signature: string, timeoutMs: number): Promise<boolean> {
  if (!css) return false;
  if (cssContains(css, signature)) return true;
  let last = mtime(css);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 250));
    const now = mtime(css);
    if (now !== last) {
      last = now;
      if (cssContains(css, signature)) return true;
    }
  }
  return false;
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

type ReloadMode = "newWindow" | "reload" | "none";

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

/**
 * Doki paints the wallpaper on the containers of the editor, side bars and panel, but newer
 * VS Code versions fill the views on top of them with opaque theme colors. Making those
 * colors transparent in workbench.colorCustomizations lets the wallpaper show through.
 * Returns the color overrides wanted by the current settings (undefined = leave the theme's).
 */
function wantedColors(): Record<string, string | undefined> {
  const cfg = carouselConfig();
  const terminal = cfg.get<boolean>("transparentTerminal", true) ? TRANSPARENT : undefined;
  const panels = cfg.get<boolean>("transparentPanels", true) ? TRANSPARENT : undefined;
  const tint = Math.min(100, Math.max(0, cfg.get<number>("quickInputTint", 65)));
  const quickInput = "#000000" + Math.round((tint / 100) * 255).toString(16).padStart(2, "0");
  return {
    "terminal.background": terminal,
    "sideBar.background": panels, // left side bar and right (auxiliary) side bar
    "sideBarSectionHeader.background": panels,
    "panel.background": panels, // bottom panel, including the terminal tabs list
    // The command palette floats over the editor with Doki's blur behind it; a translucent
    // tint keeps its text readable while the wallpaper still shows through.
    "quickInput.background": quickInput,
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
  for (const [key, value] of Object.entries(wantedColors())) {
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

async function refreshWindow() {
  const mode = carouselConfig().get<ReloadMode>("reloadMode", "newWindow");
  if (mode === "newWindow") await reopenWindow();
  else if (mode === "reload") await vscode.commands.executeCommand("workbench.action.reloadWindow");
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

function createProgress(imagePath: string): SwitchProgress {
  const mode = carouselConfig().get<ReloadMode>("reloadMode", "newWindow");
  const maximize = carouselConfig().get<boolean>("maximize", true);
  // Matches the waits in reopenWindow(), plus a moment for the window to close.
  const reopenMs = mode === "newWindow" ? SETTLE_MS + (maximize ? 500 : 0) + 1500 + 300 : SETTLE_MS + 300;
  const label = mode === "newWindow" ? "Open a new window" : "Reload the window";
  return new SwitchProgress(path.basename(imagePath), store?.get<number>(INSTALL_MS_KEY, 2500) ?? 2500, reopenMs, label);
}

/** Refresh the window, keeping the lock until the window goes away or the cooldown ends. */
async function refreshAndRelease(progress: SwitchProgress) {
  progress.setStage("reopen");
  try {
    await new Promise((r) => setTimeout(r, SETTLE_MS)); // let Doki finish fixing checksums
    await refreshWindow();
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

  const mode = carouselConfig().get<ReloadMode>("reloadMode", "newWindow");
  setSwitching(true);
  const progress = mode === "none" ? undefined : createProgress(imagePath);
  let installed = false;
  try {
    const doki = vscode.workspace.getConfiguration(DOKI_SECTION);
    for (const key of targetKeys()) {
      await doki.update(key, imagePath, scopeFor(doki, key));
    }
    if (!progress) return;

    // Doki checks its remote assets before writing, which can take a while on a slow network.
    progress.setStage("install");
    const started = Date.now();
    installed = await waitForInstall(workbenchCssPath(), imageSignature(imagePath), 30000);
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
      progress?.dispose();
      setSwitching(false);
    }
  }
  if (!progress) return;

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
    await refreshAndRelease(createProgress(imagePath));
  }
}
