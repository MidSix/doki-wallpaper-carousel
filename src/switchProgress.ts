import * as vscode from "vscode";

export type SwitchStage = "save" | "install" | "reopen";

const BAR_WIDTH = 24;
// Share of the bar each stage fills, in percent.
const RANGES: Record<SwitchStage, [number, number]> = { save: [0, 5], install: [5, 60], reopen: [60, 100] };

/** What the bar says: its title, the hint below it and the label of each stage. */
export interface SwitchSteps {
  title: string;
  placeholder: string;
  save: string;
  install: string;
  reopen: string;
}

/**
 * A progress bar where the command palette opens, shown while a wallpaper is applied. It is a
 * QuickPick used as a display: the only centered overlay an extension can show in the workbench.
 */
export class SwitchProgress implements vscode.Disposable {
  private readonly pick = vscode.window.createQuickPick();
  private readonly timer: NodeJS.Timeout;
  private stage: SwitchStage = "save";
  private stageStart = Date.now();
  private percent = 0;
  private hidden = false;

  constructor(
    private readonly steps: SwitchSteps,
    private readonly installMs: number,
    private readonly reopenMs: number
  ) {
    this.pick.title = steps.title;
    this.pick.placeholder = steps.placeholder;
    this.pick.busy = true;
    this.pick.ignoreFocusOut = true;
    // Esc only hides the bar; the switch itself keeps going.
    this.pick.onDidHide(() => (this.hidden = true));
    // Typing would filter the rows away.
    this.pick.onDidChangeValue((value) => value && (this.pick.value = ""));
    this.render();
    this.pick.show();
    this.timer = setInterval(() => this.render(), 150);
  }

  setStage(stage: SwitchStage) {
    this.stage = stage;
    this.stageStart = Date.now();
    this.render();
  }

  /** Progress inside the current stage (0–1) and the estimated time left for the whole switch. */
  private estimate(): { fraction: number; remainingMs: number } {
    const elapsed = Date.now() - this.stageStart;
    switch (this.stage) {
      case "save":
        return { fraction: 0.5, remainingMs: this.installMs + this.reopenMs };
      case "install": {
        // Doki's install time varies, so creep towards the end instead of stopping at 100 %.
        const expected = Math.max(500, this.installMs);
        const fraction = elapsed < expected ? (0.9 * elapsed) / expected : 0.9 + 0.09 * (1 - Math.exp(-(elapsed - expected) / expected));
        return { fraction, remainingMs: Math.max(0, expected - elapsed) + this.reopenMs };
      }
      case "reopen":
        return { fraction: Math.min(0.97, elapsed / this.reopenMs), remainingMs: Math.max(0, this.reopenMs - elapsed) };
    }
  }

  private render() {
    if (this.hidden) return;
    const { fraction, remainingMs } = this.estimate();
    const [from, to] = RANGES[this.stage];
    this.percent = Math.max(this.percent, Math.round(from + (to - from) * fraction));
    const filled = Math.round((this.percent / 100) * BAR_WIDTH);
    const seconds = Math.ceil(remainingMs / 1000);

    const order: SwitchStage[] = ["save", "install", "reopen"];
    const current = order.indexOf(this.stage);
    const step = (stage: SwitchStage, label: string): vscode.QuickPickItem => {
      const i = order.indexOf(stage);
      const icon = i < current ? "$(pass-filled)" : i === current ? "$(loading~spin)" : "$(circle-large-outline)";
      return { label: `${icon} ${label}`, alwaysShow: true };
    };

    this.pick.items = [
      {
        label: `${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}  ${this.percent}%`,
        description: seconds > 0 ? `about ${seconds} s left` : "almost done…",
        alwaysShow: true,
      },
      step("save", this.steps.save),
      step("install", this.steps.install),
      step("reopen", this.steps.reopen),
    ];
  }

  dispose() {
    clearInterval(this.timer);
    this.pick.dispose();
  }
}
