import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const isWindows = process.platform === "win32";
export const isMac = process.platform === "darwin";

/** Windows and (by default) macOS file systems ignore case; Linux doesn't. */
export function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return isWindows || isMac ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

// Where package managers put ffmpeg. VS Code started from the macOS Dock or a Linux desktop
// launcher may not inherit the shell PATH, so these are checked as well.
function commonDirs(): string[] {
  const home = os.homedir();
  if (isWindows) {
    const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return [
      path.join(home, "scoop", "shims"),
      path.join(local, "Microsoft", "WinGet", "Links"),
      "C:\\ProgramData\\chocolatey\\bin",
      "C:\\ffmpeg\\bin",
    ];
  }
  if (isMac) return ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/usr/bin"];
  return ["/usr/bin", "/usr/local/bin", "/snap/bin", path.join(home, ".local", "bin"), "/home/linuxbrew/.linuxbrew/bin"];
}

function isExecutable(file: string): boolean {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (!isWindows) fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Full path of `ffmpeg` / `ffprobe`: the folder in `dokiCarousel.ffmpegPath` (or the folder of
 * the executable it points to), then the PATH, then the usual install locations.
 */
export function findTool(name: "ffmpeg" | "ffprobe"): string | undefined {
  const exe = isWindows ? `${name}.exe` : name;
  const dirs: string[] = [];

  const configured = vscode.workspace.getConfiguration("dokiCarousel").get<string>("ffmpegPath", "").trim();
  if (configured) {
    const isFile = fs.existsSync(configured) && fs.statSync(configured).isFile();
    dirs.push(isFile ? path.dirname(configured) : configured);
  }
  dirs.push(...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean));
  dirs.push(...commonDirs());

  for (const dir of dirs) {
    const candidate = path.join(dir, exe);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export function ffmpegInstallHint(): string {
  if (isWindows) return "Install it with 'winget install Gyan.FFmpeg' or 'scoop install ffmpeg'";
  if (isMac) return "Install it with 'brew install ffmpeg'";
  return "Install it with your package manager, e.g. 'sudo apt install ffmpeg' or 'sudo dnf install ffmpeg'";
}

/** Tell the user ffmpeg is missing, once per session. */
let warned = false;
export function warnFfmpegMissing() {
  if (warned) return;
  warned = true;
  vscode.window
    .showWarningMessage(`ffmpeg was not found. ${ffmpegInstallHint()}, or set dokiCarousel.ffmpegPath.`, "Open Setting")
    .then((choice) => {
      if (choice) vscode.commands.executeCommand("workbench.action.openSettings", "dokiCarousel.ffmpegPath");
    });
}

/** PowerShell executable for an optional custom .ps1 converter. */
export function powershellExecutable(): string {
  return isWindows ? "powershell.exe" : "pwsh";
}
