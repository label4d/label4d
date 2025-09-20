import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import {
  events,
  type Annotation,
  type AnnotationEventPayload,
  type HighlightEventPayload,
  type PreviewEventPayload,
  type AnnotationVertex,
} from '@labelfaster/core';
import { useCore } from '../lib/core-context';

interface AnnotationObject {
  line: THREE.Line | THREE.LineLoop;
  material: THREE.LineBasicMaterial;
}

const DEFAULT_COLOR = 0x38bdf8;
const SELECTED_COLOR = 0xf97316;
const HIGHLIGHT_COLOR = 0x22c55e;

interface TopDownViewportProps {
  referenceImage?: ImageBitmap | null;
}

export function TopDownViewport({ referenceImage }: TopDownViewportProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef<number>();
  const clockRef = useRef(new THREE.Clock());
  const sceneRef = useRef<THREE.Scene>();
  const rendererRef = useRef<THREE.WebGLRenderer>();
  const cameraRef = useRef<THREE.OrthographicCamera>();
  const raycasterRef = useRef(new THREE.Raycaster());
  const planeRef = useRef(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0));
  const highlightIdsRef = useRef(new Set<string>());
  const objectsRef = useRef(new Map<string, AnnotationObject>());
  const previewLineRef = useRef<THREE.Line | null>(null);
  const drawingRef = useRef(false);
  const lastMovePointRef = useRef<THREE.Vector3 | null>(null);
  const referenceMeshRef = useRef<THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null>(null);
  const gridRef = useRef<THREE.GridHelper | null>(null);
  const { store, selection, draw, selectionController, move, mode, preview } = useCore();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#1e293b');

    const size = 100;
    const aspect = container.clientWidth / container.clientHeight;
    const camera = new THREE.OrthographicCamera(-size * aspect, size * aspect, size, -size, -200, 200);
    camera.position.set(0, 0, 100);
    camera.lookAt(0, 0, 0);

    const grid = new THREE.GridHelper(200, 40, 0x22d3ee, 0x164e63);
    grid.rotation.x = Math.PI / 2;
    scene.add(grid);
    gridRef.current = grid;

    const axes = new THREE.AxesHelper(20);
    axes.rotation.x = Math.PI / 2;
    scene.add(axes);

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;

    const previewMaterial = new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 1, gapSize: 0.5 });
    const previewGeometry = new THREE.BufferGeometry();
    const previewLine = new THREE.Line(previewGeometry, previewMaterial);
    // Only compute line distances when we have at least 2 points; initial geometry is empty
    // so we defer computeLineDistances() until vertices are provided in updatePreviewGeometry.
    previewLineRef.current = previewLine;
    scene.add(previewLine);

    const planeGeometry = new THREE.PlaneGeometry(1, 1);
    const planeMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.6, depthWrite: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const referencePlane = new THREE.Mesh(planeGeometry, planeMaterial);
    referencePlane.position.set(0, 0, 0);
    referencePlane.renderOrder = -1;
    referencePlane.visible = false;
    scene.add(referencePlane);
    referenceMeshRef.current = referencePlane;

    const animate = () => {
      applyHighlightPulse();
      renderer.render(scene, camera);
      requestRef.current = requestAnimationFrame(animate);
    };
    requestRef.current = requestAnimationFrame(animate);

    const handleResize = () => {
      if (!container) {
        return;
      }
      const { clientWidth, clientHeight } = container;
      renderer.setSize(clientWidth, clientHeight);
      const newAspect = clientWidth / clientHeight;
      camera.left = -size * newAspect;
      camera.right = size * newAspect;
      camera.updateProjectionMatrix();
    };

    window.addEventListener('resize', handleResize);

    const handleAnnotationAdded = ({ id }: AnnotationEventPayload) => {
      const annotation = store.get(id);
      if (annotation) {
        addOrUpdate(annotation);
      }
    };

    const handleAnnotationUpdated = ({ id }: AnnotationEventPayload) => {
      const annotation = store.get(id);
      if (annotation) {
        addOrUpdate(annotation);
      }
    };

    const handleAnnotationRemoved = ({ id }: AnnotationEventPayload) => {
      removeObject(id);
    };

    const handleSelectionChange = ({ selectedIds }: { selectedIds: string[] }) => {
      updateSelectionState(new Set(selectedIds));
    };

    const handleHighlight = ({ ids, active }: HighlightEventPayload) => {
      ids.forEach((itemId) => {
        if (active) {
          highlightIdsRef.current.add(itemId);
        } else {
          highlightIdsRef.current.delete(itemId);
          resetHighlight(itemId);
        }
      });
    };

    const handlePreview = (payload: PreviewEventPayload) => {
      updatePreviewGeometry(payload.vertices, payload.pending ?? undefined);
    };

    events.on('annotationAdded', handleAnnotationAdded);
    events.on('annotationUpdated', handleAnnotationUpdated);
    events.on('annotationRemoved', handleAnnotationRemoved);
    events.on('selectionChanged', handleSelectionChange);
    events.on('highlightChanged', handleHighlight);
    events.on('previewChanged', handlePreview);

    store.list().forEach(addOrUpdate);
    updateSelectionState(new Set(selection.list().map((item) => item.id)));
    preview.setVertices([]);

    const domElement = renderer.domElement;
    domElement.addEventListener('pointerdown', handlePointerDown);
    domElement.addEventListener('pointermove', handlePointerMove);
    domElement.addEventListener('pointerup', handlePointerUp);
    domElement.addEventListener('pointerleave', handlePointerCancel);
    domElement.addEventListener('dblclick', handleDoubleClick);
    domElement.addEventListener('contextmenu', handleContextMenu);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (requestRef.current) {
        cancelAnimationFrame(requestRef.current);
      }
      events.off('annotationAdded', handleAnnotationAdded);
      events.off('annotationUpdated', handleAnnotationUpdated);
      events.off('annotationRemoved', handleAnnotationRemoved);
      events.off('selectionChanged', handleSelectionChange);
      events.off('highlightChanged', handleHighlight);
      events.off('previewChanged', handlePreview);
      domElement.removeEventListener('pointerdown', handlePointerDown);
      domElement.removeEventListener('pointermove', handlePointerMove);
      domElement.removeEventListener('pointerup', handlePointerUp);
      domElement.removeEventListener('pointerleave', handlePointerCancel);
      domElement.removeEventListener('dblclick', handleDoubleClick);
      domElement.removeEventListener('contextmenu', handleContextMenu);
      renderer.dispose();
      scene.clear();
      container.removeChild(renderer.domElement);
      objectsRef.current.clear();
      highlightIdsRef.current.clear();
      previewLineRef.current = null;
      if (referenceMeshRef.current) {
        referenceMeshRef.current.geometry.dispose();
        if (referenceMeshRef.current.material.map) {
          referenceMeshRef.current.material.map.dispose();
        }
        referenceMeshRef.current.material.dispose();
        referenceMeshRef.current = null;
      }
      gridRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const plane = referenceMeshRef.current;
    if (!plane) {
      return;
    }
    if (!referenceImage) {
      plane.visible = false;
      if (plane.material.map) {
        plane.material.map.dispose();
        plane.material.map = null;
        plane.material.needsUpdate = true;
      }
      const camera = cameraRef.current;
      if (camera) {
        const size = 100;
        const aspect = (rendererRef.current?.domElement.clientWidth ?? 1) /
          (rendererRef.current?.domElement.clientHeight ?? 1);
        camera.left = -size * aspect;
        camera.right = size * aspect;
        camera.top = size;
        camera.bottom = -size;
        camera.position.set(0, 0, 100);
        camera.updateProjectionMatrix();
      }
      const grid = gridRef.current;
      if (grid) {
        grid.position.set(0, 0, 0);
        grid.scale.set(1, 1, 1);
      }
      return;
    }
    if (plane.material.map) {
      plane.material.map.dispose();
    }
    const texture = new THREE.Texture(referenceImage);
    texture.needsUpdate = true;
    plane.material.map = texture;
    plane.material.needsUpdate = true;
    plane.visible = true;
    plane.scale.set(referenceImage.width, referenceImage.height, 1);
    plane.position.set(referenceImage.width / 2, referenceImage.height / 2, 0);
    const camera = cameraRef.current;
    if (camera) {
      camera.left = 0;
      camera.right = referenceImage.width;
      camera.top = referenceImage.height;
      camera.bottom = 0;
      camera.position.set(referenceImage.width / 2, referenceImage.height / 2, 100);
      camera.updateProjectionMatrix();
    }
    const grid = gridRef.current;
    if (grid) {
      const scaleX = referenceImage.width / 200;
      const scaleY = referenceImage.height / 200;
      grid.position.set(referenceImage.width / 2, referenceImage.height / 2, 0);
      grid.scale.set(scaleX, scaleY, 1);
    }
  }, [referenceImage]);

  const addOrUpdate = (annotation: Annotation) => {
    const scene = sceneRef.current;
    if (!scene) {
      return;
    }
    const geometry = buildGeometry(annotation);
    const existing = objectsRef.current.get(annotation.id);
    if (existing) {
      existing.line.geometry.dispose();
      existing.line.geometry = geometry;
      return;
    }
    const material = new THREE.LineBasicMaterial({ color: DEFAULT_COLOR, transparent: true });
    const line = createLine(annotation.type, geometry, material);
    scene.add(line);
    objectsRef.current.set(annotation.id, { line, material });
  };

  const removeObject = (id: string) => {
    const record = objectsRef.current.get(id);
    const scene = sceneRef.current;
    if (!record || !scene) {
      return;
    }
    record.line.geometry.dispose();
    scene.remove(record.line);
    objectsRef.current.delete(id);
    highlightIdsRef.current.delete(id);
  };

  const updateSelectionState = (selected: Set<string>) => {
    objectsRef.current.forEach((entry, id) => {
      const isSelected = selected.has(id);
      entry.material.color.setHex(isSelected ? SELECTED_COLOR : DEFAULT_COLOR);
      entry.material.needsUpdate = true;
    });
  };

  const resetHighlight = (id: string) => {
    const record = objectsRef.current.get(id);
    if (!record) {
      return;
    }
    const isSelected = selection.list().some((annotation) => annotation.id === id);
    record.material.opacity = 1;
    record.material.color.setHex(isSelected ? SELECTED_COLOR : DEFAULT_COLOR);
    record.material.needsUpdate = true;
  };

  const applyHighlightPulse = () => {
    const elapsed = clockRef.current.getElapsedTime();
    highlightIdsRef.current.forEach((id) => {
      const record = objectsRef.current.get(id);
      if (!record) {
        return;
      }
      const pulse = 0.5 + 0.5 * Math.sin(elapsed * 4);
      record.material.opacity = THREE.MathUtils.clamp(pulse, 0.35, 1);
      record.material.color.setHex(HIGHLIGHT_COLOR);
      record.material.needsUpdate = true;
    });
  };

  const updatePreviewGeometry = (vertices: AnnotationVertex[], pending?: AnnotationVertex) => {
    const previewLine = previewLineRef.current;
    if (!previewLine) {
      return;
    }
    const allVertices = [...vertices];
    if (pending) {
      allVertices.push(pending);
    }
    const positionArray = new Float32Array(allVertices.length * 3);
    allVertices.forEach((vertex, index) => {
      positionArray[index * 3] = vertex.x;
      positionArray[index * 3 + 1] = vertex.y;
      positionArray[index * 3 + 2] = 0;
    });
    previewLine.geometry.dispose();
    const geometry = new THREE.BufferGeometry();
    if (positionArray.length > 0) {
      geometry.setAttribute('position', new THREE.BufferAttribute(positionArray, 3));
    }
    previewLine.geometry = geometry;
    // Only compute line distances when there are at least 2 vertices
    const posAttr = geometry.getAttribute('position');
    if (posAttr && posAttr.count >= 2) {
      previewLine.computeLineDistances();
    }
    previewLine.visible = positionArray.length > 0;
  };

  const handlePointerDown = (event: PointerEvent) => {
    if (!cameraRef.current || !rendererRef.current) {
      return;
    }
    rendererRef.current.domElement.setPointerCapture(event.pointerId);

    if (!mode.is('draw') && drawingRef.current) {
      draw.cancel();
      drawingRef.current = false;
      preview.reset();
    }

    const point = projectPointer(event);

    if (!point) {
      return;
    }

    if (mode.is('draw')) {
      handleDrawPointerDown(point);
      return;
    }

    if (mode.is('select')) {
      handleSelect(point);
      return;
    }

    if (mode.is('move')) {
      move.begin();
      lastMovePointRef.current = point;
    }
  };

  const handlePointerMove = (event: PointerEvent) => {
    if (!cameraRef.current) {
      return;
    }
    const point = projectPointer(event);
    if (!point) {
      return;
    }

    if (mode.is('draw')) {
      draw.update({ x: point.x, y: point.y, z: point.z });
      return;
    }

    if (mode.is('move') && event.buttons === 1) {
      const lastPoint = lastMovePointRef.current;
      if (lastPoint) {
        move.update({ x: point.x - lastPoint.x, y: point.y - lastPoint.y, z: 0 });
      }
      lastMovePointRef.current = point;
    }
  };

  const handlePointerUp = (event: PointerEvent) => {
    if (!cameraRef.current || !rendererRef.current) {
      return;
    }
    rendererRef.current.domElement.releasePointerCapture(event.pointerId);

    if (mode.is('move')) {
      move.end();
      lastMovePointRef.current = null;
    }
  };

  const handlePointerCancel = () => {
    if (mode.is('move')) {
      move.cancel();
      lastMovePointRef.current = null;
    }
  };

  const handleDoubleClick = (event: MouseEvent) => {
    if (!mode.is('draw')) {
      return;
    }
    const point = projectPointer(event as unknown as PointerEvent);
    if (!point) {
      return;
    }
    draw.commit({ x: point.x, y: point.y, z: point.z }, true);
    draw.finish();
    drawingRef.current = false;
  };

  const handleContextMenu = (event: MouseEvent) => {
    if (mode.is('draw')) {
      event.preventDefault();
      draw.cancel();
      preview.reset();
      drawingRef.current = false;
    }
  };

  const handleDrawPointerDown = (point: THREE.Vector3) => {
    const vertex = { x: point.x, y: point.y, z: point.z };
    if (!drawingRef.current) {
      const shape = mode.getDrawShape();
      draw.begin(shape, vertex);
      drawingRef.current = true;
    } else {
      draw.commit(vertex, false);
    }
  };

  const handleSelect = (point: THREE.Vector3) => {
    const intersection = pickAnnotation(point);
    if (intersection) {
      selectionController.selectSingle(intersection);
    } else {
      selectionController.clear();
    }
  };

  const pickAnnotation = (point: THREE.Vector3): string | null => {
    const hits: { id: string; distance: number }[] = [];
    objectsRef.current.forEach((entry, id) => {
      const distance = distanceToLine(entry.line.geometry, entry.line instanceof THREE.LineLoop, point);
      if (distance < 1.5) {
        hits.push({ id, distance });
      }
    });
    if (hits.length === 0) {
      return null;
    }
    hits.sort((a, b) => a.distance - b.distance);
    return hits[0]?.id ?? null;
  };

  const projectPointer = (event: PointerEvent): THREE.Vector3 | null => {
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    if (!renderer || !camera) {
      return null;
    }
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    raycasterRef.current.setFromCamera(ndc, camera);
    const intersection = new THREE.Vector3();
    const hit = raycasterRef.current.ray.intersectPlane(planeRef.current, intersection);
    if (!hit) {
      return null;
    }
    return intersection.clone();
  };

  return <div ref={containerRef} className="h-full w-full" />;
}

function createLine(
  type: Annotation['type'],
  geometry: THREE.BufferGeometry,
  material: THREE.LineBasicMaterial
): THREE.Line | THREE.LineLoop {
  if (type === 'polyline') {
    return new THREE.Line(geometry, material);
  }
  return new THREE.LineLoop(geometry, material);
}

function buildGeometry(annotation: Annotation): THREE.BufferGeometry {
  const vertices = annotation.getVertices();
  const geometry = new THREE.BufferGeometry();
  if (vertices.length === 0) {
    return geometry;
  }
  const positionArray = new Float32Array(vertices.length * 3);
  vertices.forEach((vertex, index) => {
    positionArray[index * 3] = vertex.x;
    positionArray[index * 3 + 1] = vertex.y;
    positionArray[index * 3 + 2] = 0;
  });
  geometry.setAttribute('position', new THREE.BufferAttribute(positionArray, 3));
  return geometry;
}

function distanceToLine(geometry: THREE.BufferGeometry, isClosed: boolean, point: THREE.Vector3): number {
  const position = geometry.getAttribute('position');
  if (!position) {
    return Infinity;
  }
  const tempA = new THREE.Vector3();
  const tempB = new THREE.Vector3();
  const temp = new THREE.Vector3();
  let minDistance = Infinity;
  for (let i = 0; i < position.count - 1; i += 1) {
    tempA.fromBufferAttribute(position, i);
    tempB.fromBufferAttribute(position, i + 1);
    const distance = pointToSegmentDistance(point, tempA, tempB, temp);
    minDistance = Math.min(minDistance, distance);
  }
  if (isClosed && position.count > 2) {
    tempA.fromBufferAttribute(position, position.count - 1);
    tempB.fromBufferAttribute(position, 0);
    const closingDistance = pointToSegmentDistance(point, tempA, tempB, temp);
    minDistance = Math.min(minDistance, closingDistance);
  }
  return minDistance;
}

function pointToSegmentDistance(
  point: THREE.Vector3,
  start: THREE.Vector3,
  end: THREE.Vector3,
  target: THREE.Vector3
): number {
  const seg = target.copy(end).sub(start);
  const l2 = seg.lengthSq();
  if (l2 === 0) {
    return point.distanceTo(start);
  }
  const t = THREE.MathUtils.clamp(point.clone().sub(start).dot(seg) / l2, 0, 1);
  return target.copy(start).add(seg.multiplyScalar(t)).distanceTo(point);
}
