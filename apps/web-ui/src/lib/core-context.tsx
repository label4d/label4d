import { createContext, useContext, useMemo, type ReactNode } from 'react';
import {
  AnnotationStore,
  DrawController,
  EditController,
  HistoryManager,
  ModeController,
  MoveController,
  PreviewService,
  SelectionController,
  SelectionSet,
  HeightMapService,
  HighlightService,
  PointCloudService,
  CoordinateService,
} from '@labelfaster/core';
import { PCDLoader } from 'three/examples/jsm/loaders/PCDLoader.js';

interface CoreServices {
  store: AnnotationStore;
  history: HistoryManager;
  selection: SelectionSet;
  draw: DrawController;
  edit: EditController;
  selectionController: SelectionController;
  move: MoveController;
  mode: ModeController;
  preview: PreviewService;
  heightMap: HeightMapService;
  highlight: HighlightService;
  pointCloud: PointCloudService;
  coordinate: CoordinateService;
}

const CoreContext = createContext<CoreServices | null>(null);

export function CoreProvider({ children }: { children: ReactNode }): JSX.Element {
  const value = useMemo<CoreServices>(() => {
    const store = new AnnotationStore();
    const history = new HistoryManager();
    const selection = new SelectionSet();
    const heightMap = new HeightMapService();
    const preview = new PreviewService();
    const coordinate = new CoordinateService();
    const pointCloudLoader = new PCDLoader();
    const pointCloud = new PointCloudService({
      load: (url: string) =>
        new Promise((resolve, reject) => {
          pointCloudLoader.load(
            url,
            (points) => {
              resolve(points.geometry);
            },
            undefined,
            (error) => reject(error)
          );
        }),
    });
    const draw = new DrawController(store, history, preview, heightMap);
    const edit = new EditController(store, history, heightMap);
    const selectionController = new SelectionController(store, selection, history);
    const move = new MoveController(store, selection, history);
    const mode = new ModeController();
    const highlight = new HighlightService();
    return {
      store,
      history,
      selection,
      draw,
      edit,
      selectionController,
      move,
      mode,
      preview,
      heightMap,
      highlight,
      pointCloud,
      coordinate,
    };
  }, []);

  return <CoreContext.Provider value={value}>{children}</CoreContext.Provider>;
}

export function useCore(): CoreServices {
  const context = useContext(CoreContext);
  if (!context) {
    throw new Error('Core context unavailable');
  }
  return context;
}
