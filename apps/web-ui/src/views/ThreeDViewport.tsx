import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { events, type Annotation, type HighlightEventPayload, type AnnotationEventPayload } from '@labelfaster/core';
import { useCore } from '../lib/core-context';

interface AnnotationObject {
  object3d: THREE.Object3D;
  material: THREE.LineBasicMaterial;
  type: Annotation['type'];
}

const DEFAULT_COLOR = 0x38bdf8;
const SELECTED_COLOR = 0xf97316;
const HIGHLIGHT_COLOR = 0x22c55e;

export function ThreeDViewport(): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef<number>();
  const clockRef = useRef(new THREE.Clock());
  const highlightIdsRef = useRef(new Set<string>());
  const objectsRef = useRef(new Map<string, AnnotationObject>());
  const pointCloudRef = useRef<THREE.Points | null>(null);
  const sceneRef = useRef<THREE.Scene>();
  const rendererRef = useRef<THREE.WebGLRenderer>();
  const cameraRef = useRef<THREE.PerspectiveCamera>();
  const controlsRef = useRef<OrbitControls>();
  const { store, selection, selectionController, mode } = useCore();
  const raycasterRef = useRef(new THREE.Raycaster());

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
    scene.background = new THREE.Color('#0f172a');

    const camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.1, 2000);
    camera.position.set(30, 25, 30);
    camera.lookAt(0, 0, 0);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;

    const grid = new THREE.GridHelper(100, 50, 0x3b82f6, 0x1e3a8a);
    scene.add(grid);

    const axes = new THREE.AxesHelper(10);
    scene.add(axes);

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;
    controlsRef.current = controls;

    const animate = () => {
      controls.update();
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
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
    };

    window.addEventListener('resize', handleResize);

    const handleAnnotationAdded = ({ id }: AnnotationEventPayload) => {
      const annotation = store.get(id);
      if (annotation) {
        addOrUpdateObject(annotation);
      }
    };

    const handleAnnotationUpdated = ({ id }: AnnotationEventPayload) => {
      const annotation = store.get(id);
      if (annotation) {
        addOrUpdateObject(annotation);
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

    const handlePointCloudLoaded = ({ geometry }: { geometry: THREE.BufferGeometry }) => {
      const scene = sceneRef.current;
      if (!scene) {
        return;
      }
      if (pointCloudRef.current) {
        scene.remove(pointCloudRef.current);
        pointCloudRef.current.geometry.dispose();
        (pointCloudRef.current.material as THREE.Material).dispose();
      }
      const geometryClone = geometry.clone();
      const material = new THREE.PointsMaterial({ size: 0.2, color: 0xffffff, sizeAttenuation: true });
      const points = new THREE.Points(geometryClone, material);
      points.name = 'pointCloud';
      scene.add(points);
      pointCloudRef.current = points;
    };

    raycasterRef.current.params.Line = { threshold: 0.5 };

    const domElement = renderer.domElement;
    domElement.addEventListener('pointerdown', handlePointerDown);

    // Register listeners
    events.on('annotationAdded', handleAnnotationAdded);
    events.on('annotationUpdated', handleAnnotationUpdated);
    events.on('annotationRemoved', handleAnnotationRemoved);
    events.on('selectionChanged', handleSelectionChange);
    events.on('highlightChanged', handleHighlight);
    events.on('pointCloudLoaded', handlePointCloudLoaded);

    // Initial population
    store.list().forEach(addOrUpdateObject);
    updateSelectionState(new Set(selection.list().map((item) => item.id)));

    return () => {
      window.removeEventListener('resize', handleResize);
      if (requestRef.current) {
        cancelAnimationFrame(requestRef.current);
      }
      domElement.removeEventListener('pointerdown', handlePointerDown);
      events.off('annotationAdded', handleAnnotationAdded);
      events.off('annotationUpdated', handleAnnotationUpdated);
      events.off('annotationRemoved', handleAnnotationRemoved);
      events.off('selectionChanged', handleSelectionChange);
      events.off('highlightChanged', handleHighlight);
      events.off('pointCloudLoaded', handlePointCloudLoaded);
      renderer.dispose();
      controls.dispose();
      scene.clear();
      container.removeChild(renderer.domElement);
      objectsRef.current.clear();
      highlightIdsRef.current.clear();
      if (pointCloudRef.current) {
        pointCloudRef.current.geometry.dispose();
        (pointCloudRef.current.material as THREE.Material).dispose();
        pointCloudRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addOrUpdateObject = (annotation: Annotation) => {
    const scene = sceneRef.current;
    if (!scene) {
      return;
    }
    const existing = objectsRef.current.get(annotation.id);
    const geometry = buildGeometry(annotation);
    if (existing) {
      existing.object3d.children.forEach((child) => {
        if (child instanceof THREE.Line) {
          const line = child as THREE.Line;
          line.geometry.dispose();
          line.geometry = geometry;
        }
      });
      return;
    }

    const material = new THREE.LineBasicMaterial({ color: DEFAULT_COLOR, transparent: true });
    const line = createLine(annotation.type, geometry, material);
    const group = new THREE.Group();
    group.add(line);
    group.userData.id = annotation.id;
    scene.add(group);
    objectsRef.current.set(annotation.id, {
      object3d: group,
      material,
      type: annotation.type,
    });
  };

  const removeObject = (id: string) => {
    const record = objectsRef.current.get(id);
    const scene = sceneRef.current;
    if (!record || !scene) {
      return;
    }
    record.object3d.traverse((child) => {
      if (child instanceof THREE.Line) {
        child.geometry.dispose();
      }
    });
    scene.remove(record.object3d);
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

  const handlePointerDown = (event: PointerEvent) => {
    if (!mode.is('select')) {
      return;
    }
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    const scene = sceneRef.current;
    if (!renderer || !camera || !scene) {
      return;
    }
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    raycasterRef.current.setFromCamera(ndc, camera);
    const candidates: THREE.Object3D[] = [];
    objectsRef.current.forEach((entry) => {
      candidates.push(entry.object3d);
    });
    const intersections = raycasterRef.current.intersectObjects(candidates, true);
    if (intersections.length > 0) {
      const hit = intersections[0].object;
      const annotationId = findAnnotationId(hit);
      if (annotationId) {
        selectionController.selectSingle(annotationId);
        return;
      }
    }
    selectionController.clear();
  };

  const findAnnotationId = (object: THREE.Object3D | null): string | null => {
    let current: THREE.Object3D | null = object;
    while (current) {
      if (typeof current.userData.id === 'string') {
        return current.userData.id;
      }
      current = current.parent;
    }
    return null;
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
  if (vertices.length === 0) {
    return new THREE.BufferGeometry();
  }
  const positionArray = new Float32Array(vertices.length * 3);
  vertices.forEach((vertex, index) => {
    positionArray[index * 3] = vertex.x;
    positionArray[index * 3 + 1] = vertex.y;
    positionArray[index * 3 + 2] = vertex.z ?? 0;
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positionArray, 3));
  return geometry;
}
