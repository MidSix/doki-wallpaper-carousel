// Run by VS Code (package.json "vscode:uninstall") once the extension is uninstalled, in plain
// Node without the vscode API: takes our CSS block out of the stylesheets it was written to, so
// the wallpaper doesn't stay hidden in the editor or terminal after the extension is gone.
import * as fs from "fs";
import { PATCHED_LIST, applyOverrides } from "./cssOverrides";

let files: string[] = [];
try {
  files = JSON.parse(fs.readFileSync(PATCHED_LIST, "utf-8"));
} catch {
  // Nothing was ever written.
}
for (const file of files) {
  try {
    if (fs.existsSync(file)) applyOverrides(file, "");
  } catch (err) {
    console.error(`Wallpaper Carousel: could not clean ${file}: ${err}`);
  }
}
