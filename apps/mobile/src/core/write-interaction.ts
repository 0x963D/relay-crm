import type { Command } from "./write-model.ts";
import type { WriteState } from "./write-machine.ts";

export class WriteInteraction {
  private busyUntil = 0;
  private handoffStarted = false;
  confirmation: { readonly command: Command; readonly readyAt: number } | null = null;
  private readonly now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }
  startBusy() {
    this.busyUntil = this.now() + 400;
  }
  displayDelay(state: WriteState) {
    return ["storing", "sendingFirst", "sendingRetry"].includes(state)
      ? 0
      : Math.max(0, this.busyUntil - this.now());
  }
  confirm(command: Command) {
    this.confirmation = { command, readyAt: this.now() + 400 };
    return this.confirmation;
  }
  withdraw() {
    this.confirmation = null;
  }
  accept(signedIn: boolean) {
    if (!this.confirmation || !signedIn || this.now() < this.confirmation.readyAt) return null;
    const command = this.confirmation.command;
    this.withdraw();
    this.startBusy();
    return command;
  }
  startHandoff(
    presented: boolean,
    phone: string | undefined,
    initialized: boolean,
    hasEntry: boolean,
  ) {
    if (!presented || !phone || !initialized || this.handoffStarted || hasEntry) return false;
    this.handoffStarted = true;
    return true;
  }
}
