import type { BufferGeometry } from 'three';
import type { AnnotationVertex } from '../types/geometry';

export type AnnotationId = string;

export interface AnnotationEventPayload {
  id: AnnotationId;
}

export interface AnnotationUpdatedPayload extends AnnotationEventPayload {
  changedVertices?: number[];
}

export interface SelectionChangedPayload {
  selectedIds: AnnotationId[];
}

export interface HistoryEventPayload {
  undoCount: number;
  redoCount: number;
}

export interface HighlightEventPayload {
  ids: AnnotationId[];
  active: boolean;
  mode: 'flash' | 'pulse';
}

export interface PointCloudLoadedPayload {
  url: string;
  geometry: BufferGeometry;
}

export interface PreviewEventPayload {
  vertices: AnnotationVertex[];
  pending?: AnnotationVertex | null;
}

export type CoreEventMap = {
  annotationAdded: AnnotationEventPayload;
  annotationUpdated: AnnotationUpdatedPayload;
  annotationRemoved: AnnotationEventPayload;
  selectionChanged: SelectionChangedPayload;
  historyChanged: HistoryEventPayload;
  highlightChanged: HighlightEventPayload;
  pointCloudLoaded: PointCloudLoadedPayload;
  previewChanged: PreviewEventPayload;
};
