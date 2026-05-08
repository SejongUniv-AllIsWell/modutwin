'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export interface ColmapResultData {
  num_points: number;
  num_cameras: number;
  /** [x, y, z, r, g, b] — r/g/b는 0~255 */
  points: number[][];
  cameras: {
    name: string;
    position: [number, number, number];
    R: [[number, number, number], [number, number, number], [number, number, number]];
    fx: number; fy: number;
    cx: number; cy: number;
    width: number; height: number;
  }[];
}

export interface TrainingBounds {
  minX: number; maxX: number;
  minY: number; maxY: number;
  minZ: number; maxZ: number;
}

interface Props {
  data: ColmapResultData;
  trainingBounds?: TrainingBounds | null;
}

const DIM = 0.12; // 범위 밖 포인트 밝기 비율

export default function ColmapViewer({ data, trainingBounds }: Props) {
  const mountRef         = useRef<HTMLDivElement>(null);
  const boxHelperRef     = useRef<THREE.Box3Helper | null>(null);
  const sceneRef         = useRef<THREE.Scene | null>(null);
  const pointsRef        = useRef<THREE.Points | null>(null);
  const originalColorsRef = useRef<Float32Array | null>(null);

  useEffect(() => {
    if (!mountRef.current) return;
    const container = mountRef.current;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111111);
    sceneRef.current = scene;

    const cam = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.001, 1000);
    cam.position.set(0, 0, 3);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(cam, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // 포인트클라우드 (전체)
    if (data.points.length > 0) {
      const positions = new Float32Array(data.points.length * 3);
      const colors    = new Float32Array(data.points.length * 3);
      for (let i = 0; i < data.points.length; i++) {
        const [x, y, z, r, g, b] = data.points[i];
        positions[i * 3]     = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z;
        colors[i * 3]     = r / 255; colors[i * 3 + 1] = g / 255; colors[i * 3 + 2] = b / 255;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
      const mat = new THREE.PointsMaterial({ size: 0.008, vertexColors: true, sizeAttenuation: true });
      const pointsMesh = new THREE.Points(geo, mat);
      scene.add(pointsMesh);
      pointsRef.current = pointsMesh;
      originalColorsRef.current = colors.slice();

      geo.computeBoundingSphere();
      const center = geo.boundingSphere!.center;
      const radius = geo.boundingSphere!.radius;
      controls.target.copy(center);
      cam.position.set(center.x, center.y, center.z + radius * 2);
      controls.update();
    }

    // 카메라 프러스텀
    const lineMat = new THREE.LineBasicMaterial({ color: 0xff3333 });
    for (const camData of data.cameras) {
      const pos = new THREE.Vector3(...camData.position);
      const R   = camData.R;
      const RT  = [[R[0][0], R[1][0], R[2][0]], [R[0][1], R[1][1], R[2][1]], [R[0][2], R[1][2], R[2][2]]] as const;
      const d = 0.15;
      const hw = (d * camData.width  / 2) / camData.fx;
      const hh = (d * camData.height / 2) / camData.fy;
      const corners: [number, number, number][] = [[-hw, -hh, d], [hw, -hh, d], [hw, hh, d], [-hw, hh, d]];
      const tr = ([cx, cy, cz]: [number, number, number]) =>
        new THREE.Vector3(
          RT[0][0]*cx + RT[0][1]*cy + RT[0][2]*cz + pos.x,
          RT[1][0]*cx + RT[1][1]*cy + RT[1][2]*cz + pos.y,
          RT[2][0]*cx + RT[2][1]*cy + RT[2][2]*cz + pos.z,
        );
      const c = corners.map(tr);
      const verts = [pos, c[0], pos, c[1], pos, c[2], pos, c[3], c[0], c[1], c[1], c[2], c[2], c[3], c[3], c[0]];
      scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(verts), lineMat));
    }

    scene.add(new THREE.AxesHelper(0.3));

    const onResize = () => {
      cam.aspect = container.clientWidth / container.clientHeight;
      cam.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };
    window.addEventListener('resize', onResize);

    let animId: number;
    const animate = () => { animId = requestAnimationFrame(animate); controls.update(); renderer.render(scene, cam); };
    animate();

    return () => {
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(animId);
      controls.dispose();
      renderer.dispose();
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
      boxHelperRef.current = null;
      sceneRef.current = null;
      pointsRef.current = null;
      originalColorsRef.current = null;
    };
  }, [data]);

  // 학습 범위 박스 + 범위 밖 포인트 어둡게
  useEffect(() => {
    const scene  = sceneRef.current;
    const points = pointsRef.current;
    const orig   = originalColorsRef.current;
    if (!scene) return;

    // 박스 헬퍼 갱신
    if (boxHelperRef.current) {
      scene.remove(boxHelperRef.current);
      boxHelperRef.current = null;
    }
    if (trainingBounds) {
      const box = new THREE.Box3(
        new THREE.Vector3(trainingBounds.minX, trainingBounds.minY, trainingBounds.minZ),
        new THREE.Vector3(trainingBounds.maxX, trainingBounds.maxY, trainingBounds.maxZ),
      );
      const helper = new THREE.Box3Helper(box, new THREE.Color(0x44aaff));
      scene.add(helper);
      boxHelperRef.current = helper;
    }

    // 색상 업데이트: 범위 밖은 어둡게
    if (!points || !orig) return;
    const colAttr = points.geometry.getAttribute('color') as THREE.BufferAttribute;
    const posAttr = points.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = colAttr.array as Float32Array;

    for (let i = 0; i < posAttr.count; i++) {
      const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
      const inside = !trainingBounds || (
        x >= trainingBounds.minX && x <= trainingBounds.maxX &&
        y >= trainingBounds.minY && y <= trainingBounds.maxY &&
        z >= trainingBounds.minZ && z <= trainingBounds.maxZ
      );
      const factor = inside ? 1.0 : DIM;
      col[i * 3]     = orig[i * 3]     * factor;
      col[i * 3 + 1] = orig[i * 3 + 1] * factor;
      col[i * 3 + 2] = orig[i * 3 + 2] * factor;
    }
    colAttr.needsUpdate = true;
  }, [trainingBounds]);

  return (
    <div className="relative w-full h-full min-h-[500px]">
      <div ref={mountRef} className="w-full h-full" />
      <div className="absolute top-3 left-3 bg-black/60 rounded p-2 text-xs text-gray-300 space-y-1 pointer-events-none">
        <div className="flex items-center gap-2">
          <span className="inline-block w-3 h-3 rounded-full bg-white opacity-70" />
          <span>Sparse point cloud ({data.num_points.toLocaleString()}pt)</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-block w-3 h-1 bg-red-500" />
          <span>카메라 ({data.num_cameras}개)</span>
        </div>
        {trainingBounds && (
          <div className="flex items-center gap-2">
            <span className="inline-block w-3 h-1 bg-blue-400" />
            <span>학습 범위</span>
          </div>
        )}
        <div className="mt-1 text-gray-500">드래그: 회전 / 스크롤: 줌 / 우클릭: 이동</div>
      </div>
    </div>
  );
}
