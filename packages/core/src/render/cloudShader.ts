import * as THREE from 'three';

export const CLOUD_POINT_SIZE = 2;

/**
 * 高度/强度着色点云材质：圆点裁切 + 全局统一色域（蓝→红）。
 * 高度模式直接取世界坐标 y；强度模式读 intensity 顶点属性（数据源需有有效强度）。
 * 默认固定 CSS 像素圆点；单帧和 Potree 共用点形状及像素比换算。
 */
export interface CloudShaderOptions {
  /** 0=高度着色（世界 y），1=强度着色（intensity 顶点属性） */
  mode?: 0 | 1;
  /** 归一化范围 [min, max]，全局统一，避免分块各自计算暴露边界 */
  range?: [number, number];
  /** Fixed mode: CSS pixels; legacy attenuated mode: size parameter. */
  pointSize?: number;
  /** Fixed screen size, independent of distance. Defaults to true. */
  fixedPixels?: boolean;
  /** Read linear RGB from the pointColor attribute. */
  vertexColors?: boolean;
  lowColor?: string;
  highColor?: string;
}

export function createCloudShaderMaterial(options: CloudShaderOptions = {}): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uPixelRatio: { value: 1 },
      uVertexColors: { value: options.vertexColors ?? false },
      uMode: { value: options.mode ?? 0 },
      uRange: { value: new THREE.Vector2(...(options.range ?? [-3, 10])) },
      uFixedPixels: { value: options.fixedPixels ?? true },
      uPointSize: { value: options.pointSize ?? CLOUD_POINT_SIZE },
      uLowColor: { value: new THREE.Color(options.lowColor ?? '#3a6fd8') },
      uHighColor: { value: new THREE.Color(options.highColor ?? '#e8462a') },
    },
    vertexShader: `
      attribute float intensity;
      attribute vec3 pointColor;
      varying vec3 vPointColor;
      uniform float uPixelRatio;

      uniform int uMode;
      uniform vec2 uRange;
      uniform float uPointSize;
      uniform bool uFixedPixels;

      varying float vT;

      void main() {
        vPointColor = pointColor;
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vec4 viewPosition = viewMatrix * worldPosition;

        float value = uMode == 0 ? worldPosition.y : intensity;
        vT = clamp(
          (value - uRange.x) / max(uRange.y - uRange.x, 0.000001),
          0.0,
          1.0
        );

        gl_Position = projectionMatrix * viewPosition;
        // 世界单位点尺寸：随距离衰减，分块边界大小连续
        gl_PointSize = uFixedPixels ? uPointSize * uPixelRatio : uPointSize * (300.0 / max(-viewPosition.z, 1.0));
      }
    `,
    fragmentShader: `
      uniform bool uVertexColors;
      varying vec3 vPointColor;
      uniform vec3 uLowColor;
      uniform vec3 uHighColor;

      varying float vT;

      void main() {
        // 圆点裁切：方形点内部坐标 0~1，半径外丢弃
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        if (dot(p, p) > 1.0) discard;

        vec3 color = uVertexColors ? vPointColor : mix(uLowColor, uHighColor, vT);
        gl_FragColor = vec4(color, 1.0);

        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    depthTest: true,
    depthWrite: true,
    transparent: false,
  });
  // 缺少 intensity 属性时给默认值，避免 WebGL 缺属性报错
  (material.defaultAttributeValues as Record<string, unknown>).intensity = [0];
  (material.defaultAttributeValues as Record<string, unknown>).pointColor = [1, 1, 1];
  material.onBeforeRender = (renderer) => {
    material.uniforms.uPixelRatio.value = renderer.getPixelRatio();
  };
  return material;
}
