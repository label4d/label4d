import type { HighlightService } from '../../services/HighlightService';
import type { Command } from '../Command';

export class ToggleHighlightCommand implements Command {
  readonly description: string;
  private previousState = false;

  constructor(
    private readonly highlightService: HighlightService,
    private readonly ids: string[],
    private readonly mode: 'flash' | 'pulse',
    private readonly active: boolean
  ) {
    this.description = `${active ? 'Enable' : 'Disable'} highlight`;
  }

  execute(): void {
    this.previousState = this.highlightService.isActive(this.ids, this.mode);
    this.highlightService.setActive(this.ids, this.mode, this.active);
  }

  undo(): void {
    this.highlightService.setActive(this.ids, this.mode, this.previousState);
  }
}
