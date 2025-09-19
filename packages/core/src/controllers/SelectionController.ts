import { AnnotationStore } from '../models/AnnotationStore';
import { SelectionSet } from '../models/SelectionSet';
import { events } from '../events/EventDispatcher';
import { HistoryManager } from '../history/HistoryManager';
import { DeleteAnnotationsCommand } from '../history/commands/DeleteAnnotationsCommand';

export class SelectionController {
  constructor(
    private readonly store: AnnotationStore,
    private readonly selection: SelectionSet,
    private readonly history: HistoryManager
  ) {}

  selectSingle(annotationId: string): void {
    this.selection.clear();
    const annotation = this.store.get(annotationId);
    if (!annotation) {
      this.emit();
      return;
    }
    this.selection.add(annotation);
    this.emit();
  }

  toggle(annotationId: string): void {
    if (this.selection.has(annotationId)) {
      this.selection.remove(annotationId);
    } else {
      const annotation = this.store.get(annotationId);
      if (annotation) {
        this.selection.add(annotation);
      }
    }
    this.emit();
  }

  clear(): void {
    this.selection.clear();
    this.emit();
  }

  deleteSelected(): void {
    const ids = this.getSelection();
    if (ids.length === 0) {
      return;
    }
    const command = new DeleteAnnotationsCommand(this.store, ids);
    this.history.push(command);
    this.selection.clear();
    this.emit();
  }

  getSelection(): string[] {
    return this.selection.list().map((annotation) => annotation.id);
  }

  private emit(): void {
    events.emit('selectionChanged', { selectedIds: this.getSelection() });
  }
}
