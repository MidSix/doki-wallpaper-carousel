import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { removeOwnedColors } from "./doki";

const DOKI_ID = "unthrottled.doki-theme";

/**
 * Doki Theme came along with this extension (an extensionDependency), and VS Code never offers
 * to remove dependencies. The "vscode:uninstall" script runs later, without any UI, so the
 * question is asked from here: an uninstalled extension keeps running until the extensions
 * restart. VS Code takes it out of the extensions folder's extensions.json right away, and out
 * of vscode.extensions when it can.
 */
export function watchUninstall(context: vscode.ExtensionContext) {
  const ownId = context.extension.id.toLowerCase();
  const registry = path.join(path.dirname(context.extensionPath), "extensions.json");
  // Only a registry that lists us now can show that we were removed (not in a development host
  // or a profile with its own list).
  const listed = () => {
    try {
      const entries: { identifier?: { id?: string } }[] = JSON.parse(fs.readFileSync(registry, "utf-8"));
      return entries.some((e) => e.identifier?.id?.toLowerCase() === ownId);
    } catch {
      return undefined; // missing, or caught halfway through a write
    }
  };
  const watchRegistry = listed() === true;

  let timer: NodeJS.Timeout | undefined;
  let asked = false;
  const check = () => {
    // Reinstalling or updating rewrites the list too: only a removal still there a moment later counts.
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (asked) return;
      const removed = (watchRegistry && listed() === false) || !vscode.extensions.getExtension(context.extension.id);
      if (!removed) return;
      asked = true;
      onUninstalled(context);
    }, 2000);
  };

  context.subscriptions.push(vscode.extensions.onDidChange(check), { dispose: () => clearTimeout(timer) });
  if (watchRegistry) {
    try {
      const watcher = fs.watch(path.dirname(registry), (_event, file) => file === "extensions.json" && check());
      context.subscriptions.push({ dispose: () => watcher.close() });
    } catch {
      // No watching: the extensions API above still notices it where it can.
    }
  }
}

async function onUninstalled(context: vscode.ExtensionContext) {
  // The colors that let the wallpaper show through the side bars, panel and terminal go with us.
  await removeOwnedColors(context);
  // Every window gets here; the one the user is working in asks.
  if (!vscode.window.state.focused || !vscode.extensions.getExtension(DOKI_ID)) return;

  const uninstall: vscode.MessageItem = { title: "Uninstall Doki Theme" };
  const keep: vscode.MessageItem = { title: "Keep Doki Theme", isCloseAffordance: true };
  const choice = await vscode.window.showInformationMessage(
    "Wallpaper Carousel for Doki Theme was uninstalled. Uninstall Doki Theme too?",
    {
      modal: true,
      detail:
        "Wallpaper Carousel depends on the Doki Theme extension, which was installed along with it. Doki Theme also gives VS Code its themes, stickers and wallpapers: keep it if you still want to use them.",
    },
    uninstall,
    keep
  );
  if (choice !== uninstall) return;
  try {
    await vscode.commands.executeCommand("workbench.extensions.uninstallExtension", DOKI_ID);
  } catch (err) {
    vscode.window.showErrorMessage(`Could not uninstall Doki Theme: ${err}. You can uninstall it from the Extensions view.`);
  }
}
