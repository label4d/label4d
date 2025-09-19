export interface Command {
  readonly description: string;
  execute(): void;
  undo(): void;
}

export class CompositeCommand implements Command {
  readonly description: string;
  private readonly commands: Command[];

  constructor(description: string, commands: Command[]) {
    this.description = description;
    this.commands = commands;
  }

  execute(): void {
    for (const command of this.commands) {
      command.execute();
    }
  }

  undo(): void {
    for (const command of [...this.commands].reverse()) {
      command.undo();
    }
  }
}
