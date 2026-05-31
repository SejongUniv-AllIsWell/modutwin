'use client';

import {
  useEffect, useRef, useState, useCallback,
  forwardRef, useImperativeHandle,
} from 'react';
import {
  _half2Float,
  calcForwardVec,
  getLookDir,
  getRightDir,
} from './tools/cameraMath';

// ── 외부 노출 타입 ──

export interface SplatData {
  numSplats: number;
  posX: Float32Array;
  posY: Float32Array;
  posZ: Float32Array;
  colorTexture: any;
  origColorData: Uint16Array | null;   // half-float RGBA
  splatEntity: any;
  /** transformA 텍스처 (위치+회전xy GPU 데이터) */
  transformATexture: any;
  /** transformB 텍스처 (스케일+회전z GPU 데이터) */
  transformBTexture: any;
  /** GSplatResource (centers, sorter 접근용) */
  resource: any;
  /** gsplatData (rot_0~3 등 속성 접근용) */
  gsplatData: any;
}

export interface SplatViewerCoreRef {
  getApp: () => any | null;
  getCamera: () => any | null;
  getCanvas: () => HTMLCanvasElement | null;
  getContainer: () => HTMLDivElement | null;
  /** 뷰어 최상위 wrapper (전체화면 타겟). 오버레이·미니맵까지 포함. */
  getRoot: () => HTMLDivElement | null;
  getSplatData: () => SplatData | null;
  getPC: () => any | null;
  float2Half: (v: number) => number;
  half2Float: (h: number) => number;
  /** PlayCanvas update loop에 콜백 등록. 해제 함수 반환 */
  onUpdate: (cb: (dt: number) => void) => () => void;
  /** PlayCanvas app.drawLine 래퍼 */
  drawLine: (a: [number, number, number], b: [number, number, number], color: [number, number, number, number], depthTest?: boolean) => void;
  /** 메인 splat 엔티티 visibility 토글 */
  setMainVisible: (visible: boolean) => void;
  /** 정합 모드: 모듈 entity 들 (splat + wall mesh + door mesh + module 추가 splat) 을
   *  공통 부모 alignmentGroup 아래로 이동. basemap 으로 표시된 추가 splat 은 제외.
   *  반환: alignmentGroup entity (transform 적용 대상). 이미 진입 상태면 기존 group 반환.
   *  같은 entity 가 두 번 reparent 되어도 안전 (idempotent). */
  enterAlignmentMode: () => any | null;
  /** 정합 모드 종료. children 을 다시 app.root 로 이동, alignmentGroup destroy. */
  exitAlignmentMode: () => void;
  /** 현재 alignmentGroup entity. 진입 안 했으면 null. */
  getAlignmentGroup: () => any | null;
  /** 메인 splat 을 새 URL (blob URL 가능) 로 재로드. 카메라 보존 옵션 지원. asset.ready 까지 await. */
  reloadSplatFromUrl: (url: string, opts?: { preserveCamera?: boolean }) => Promise<void>;
}

interface SplatViewerCoreProps {
  /** 없으면 빈 viewer만 표시 (카메라/기즈모만 활성). */
  sogUrl?: string | null;
  onSplatLoaded?: (data: SplatData) => void;
  children?: React.ReactNode;
}

type CameraMode = 'fly' | 'orbit';

const SplatViewerCore = forwardRef<SplatViewerCoreRef, SplatViewerCoreProps>(
  ({ sogUrl, onSplatLoaded, children }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [cameraMode, setCameraMode] = useState<CameraMode>('fly');
    const [moveSpeed, setMoveSpeed] = useState(0.5);
    const [shiftActive, setShiftActive] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    /**
     * PlayCanvas 앱이 준비되어 splat 로드를 받을 수 있는 상태.
     * - 마운트 시 false → init useEffect의 async 초기화가 끝나면 true
     * - sogUrl 변경 → splat-load useEffect는 appReady===true일 때만 동작
     */
    const [appReady, setAppReady] = useState(false);

    const cameraModeRef = useRef<CameraMode>('fly');
    const moveSpeedRef = useRef(0.5);
    const appRef = useRef<any>(null);
    const cameraEntityRef = useRef<any>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const splatDataRef = useRef<SplatData | null>(null);
    const splatEntityRef = useRef<any>(null);
    // 정합 모드용 공통 부모 entity. enterAlignmentMode 가 생성, exitAlignmentMode 가 정리.
    const alignmentGroupRef = useRef<any>(null);
    const syncOrbitFromFlyRef = useRef<() => void>(() => {});
    const float2HalfRef = useRef<(v: number) => number>((v) => v);
    const updateCallbacksRef = useRef<Set<(dt: number) => void>>(new Set());
    const pcRef = useRef<any>(null);
    // splat 로드 인터페이스 — init 완료 후 첫 useEffect에서 채워짐.
    // 두 번째 useEffect (sogUrl 변경 트리거) 가 호출.
    const loadSplatRef = useRef<((url: string, opts?: { preserveCamera?: boolean }) => Promise<void>) | null>(null);
    const clearSplatRef = useRef<(() => void) | null>(null);
    // 콜백 identity가 매 렌더마다 바뀌어도 effect가 재실행되지 않도록 ref로 보관
    const onSplatLoadedRef = useRef(onSplatLoaded);
    useEffect(() => { onSplatLoadedRef.current = onSplatLoaded; }, [onSplatLoaded]);

    // ── 외부 노출 API ──
    useImperativeHandle(ref, () => ({
      getApp: () => appRef.current,
      getCamera: () => cameraEntityRef.current,
      getCanvas: () => canvasRef.current,
      getContainer: () => containerRef.current,
      getRoot: () => rootRef.current,
      getSplatData: () => splatDataRef.current,
      getPC: () => pcRef.current,
      float2Half: (v: number) => float2HalfRef.current(v),
      half2Float: _half2Float,
      onUpdate: (cb: (dt: number) => void) => {
        updateCallbacksRef.current.add(cb);
        return () => { updateCallbacksRef.current.delete(cb); };
      },
      drawLine: (a, b, color, depthTest = false) => {
        const app = appRef.current;
        const pc = pcRef.current;
        if (!app || !pc) return;
        app.drawLine(
          new pc.Vec3(a[0], a[1], a[2]),
          new pc.Vec3(b[0], b[1], b[2]),
          new pc.Color(color[0], color[1], color[2], color[3]),
          depthTest,
        );
      },
      setMainVisible: (visible: boolean) => {
        const ent = splatEntityRef.current;
        if (ent) ent.enabled = visible;
      },
      enterAlignmentMode: () => {
        const app = appRef.current;
        const pc = pcRef.current;
        if (!app || !pc) return null;
        let group = alignmentGroupRef.current;
        if (!group) {
          group = new pc.Entity('alignmentGroup');
          app.root.addChild(group);
          alignmentGroupRef.current = group;
        }
        // app.root 의 children 중 module-side entity 를 group 아래로 이동.
        // 판별 규칙:
        //   name === 'splat'                       → 본체
        //   name.startsWith('wallMesh_')           → 6 면 벽 메시
        //   name.startsWith('doorMesh_')           → 도어 메시
        //   name.startsWith('add_splat_') && tag 'basemap' 미부여 → 도어 sub-splat 등 module-side
        // basemap (tag 'basemap') 은 제외.
        // 정리 단계: 이전 호출에서 잘못 들어간 basemap-tag entity 가 group 안에 있으면 root 로 복귀.
        const groupChildren: any[] = group.children?.slice() ?? [];
        for (const c of groupChildren) {
          if (c?.tags?.has?.('basemap')) {
            app.root.addChild(c);
          }
        }
        const moveCandidates: any[] = app.root.children.slice();
        for (const c of moveCandidates) {
          if (c === group) continue;
          if (c === cameraEntityRef.current) continue;
          const name: string = c.name ?? '';
          const isModuleSplat = name === 'splat';
          const isWall = name.startsWith('wallMesh_');
          const isDoor = name.startsWith('doorMesh_');
          const isAddSplat = name.startsWith('add_splat_');
          // moduleDoor wrapper — mesh + splat 자식 통째로 정합 transform 대상.
          const isModuleDoorWrapper = name === 'moduleDoor';
          // basemap tag 가 붙은 entity 는 module 정합 transform 적용 대상이 아님 → 무조건 제외.
          // (useRefinedMeshLoader 가 추가하는 basemap 의 wallMesh/doorMesh/add_splat 모두 'basemap' tag.)
          const hasBasemapTag = c.tags?.has?.('basemap');
          if (hasBasemapTag) continue;
          const include = isModuleSplat || isWall || isDoor || isAddSplat || isModuleDoorWrapper;
          if (!include) continue;
          group.addChild(c);
        }
        return group;
      },
      exitAlignmentMode: () => {
        const app = appRef.current;
        const group = alignmentGroupRef.current;
        if (!app || !group) return;
        // children 을 app.root 로 되돌림 (group 의 transform 은 적용된 채로 유지될 수 있어
        // 호출자가 반드시 정합 결과 저장 또는 reset 후 호출해야 함).
        const children = group.children.slice();
        for (const c of children) app.root.addChild(c);
        try { group.destroy(); } catch {}
        alignmentGroupRef.current = null;
      },
      getAlignmentGroup: () => alignmentGroupRef.current,
      reloadSplatFromUrl: (url: string, opts?: { preserveCamera?: boolean }) => {
        const fn = loadSplatRef.current;
        if (!fn) return Promise.reject(new Error('splat loader not ready'));
        return fn(url, opts);
      },
    }));

    // ── Shift 키 상태 추적 (이동속도 표시에 반영) ──
    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Shift') setShiftActive(e.type === 'keydown');
      };
      const clear = () => setShiftActive(false);
      window.addEventListener('keydown', onKey);
      window.addEventListener('keyup', onKey);
      window.addEventListener('blur', clear);
      document.addEventListener('visibilitychange', clear);
      return () => {
        window.removeEventListener('keydown', onKey);
        window.removeEventListener('keyup', onKey);
        window.removeEventListener('blur', clear);
        document.removeEventListener('visibilitychange', clear);
      };
    }, []);

    // ── PlayCanvas 초기화 (mount-once) ──
    // 앱/카메라/입력 처리는 마운트 시 한 번만 만들어 splat 교체 시에도 유지한다.
    // splat 자체의 로드/교체는 아래 두 번째 useEffect가 sogUrl을 보고 처리.
    useEffect(() => {
      if (!containerRef.current) return;

      let app: any = null;
      let destroyed = false;
      const cleanups: (() => void)[] = [];
      // 현재 진행 중인 splat 로드의 cancel 토큰. loadSplat 호출 시 이전 진행을 취소.
      let activeCancel: (() => void) | null = null;

      (async () => {
        try {
          const pc = await import('playcanvas');
          if (destroyed) return;
          pcRef.current = pc;

          // half-float helper
          float2HalfRef.current = (pc as any).FloatPacking.float2Half;

          const canvas = document.createElement('canvas');
          canvas.style.width = '100%';
          canvas.style.height = '100%';
          containerRef.current!.appendChild(canvas);
          canvasRef.current = canvas;

          app = new pc.Application(canvas, {
            mouse: new pc.Mouse(canvas),
            touch: new pc.TouchDevice(canvas),
            // TEMP_METRICS_EVAL: canvas PNG capture for PSNR/SSIM experiments needs the drawing buffer preserved.
            // Remove preserveDrawingBuffer after the paper metric capture is done.
            graphicsDeviceOptions: { antialias: false, preserveDrawingBuffer: true },
          });
          appRef.current = app;
          app.setCanvasFillMode(pc.FILLMODE_NONE);
          app.setCanvasResolution(pc.RESOLUTION_AUTO);

          // ── 카메라 ──
          const cameraEntity = new pc.Entity('camera');
          cameraEntity.addComponent('camera', {
            clearColor: new pc.Color(0.08, 0.08, 0.08),
            farClip: 10000,
            nearClip: 0.01,
          });
          app.root.addChild(cameraEntity);
          cameraEntityRef.current = cameraEntity;

          // ── 카메라 상태 ──
          let azim = 0, elev = -15;
          const camPos = new pc.Vec3(0, 0, 3);
          let orbitRadius = 3;
          const orbitTarget = new pc.Vec3(0, 0, 0);

          const syncCamera = () => {
            if (cameraModeRef.current === 'orbit') {
              const fwd = calcForwardVec(azim, elev);
              camPos.set(
                orbitTarget.x + fwd.x * orbitRadius,
                orbitTarget.y + fwd.y * orbitRadius,
                orbitTarget.z + fwd.z * orbitRadius,
              );
            }
            cameraEntity.setLocalPosition(camPos.x, camPos.y, camPos.z);
            cameraEntity.setLocalEulerAngles(elev, azim, 0);
          };
          syncCamera();

          syncOrbitFromFlyRef.current = () => {
              const lookDir = getLookDir(azim, elev);
              orbitRadius = 3;
              orbitTarget.set(
                camPos.x + lookDir.x * orbitRadius,
                camPos.y + lookDir.y * orbitRadius,
                camPos.z + lookDir.z * orbitRadius,
            );
          };

          // ── 기즈모 (drawLine + DOM 라벨) ──
          const gizmoColorX = new pc.Color(1, 0.2, 0.2, 1);
          const gizmoColorY = new pc.Color(0.2, 1, 0.2, 1);
          const gizmoColorZ = new pc.Color(0.3, 0.5, 1, 1);

          const makeLabel = (text: string, color: string) => {
            const el = document.createElement('div');
            el.textContent = text;
            // z-index 50: refine UI 패널보다 위에 보이도록
            el.style.cssText = `position:absolute;pointer-events:none;font-size:13px;font-weight:bold;color:${color};text-shadow:0 0 4px #000, 0 0 2px #000;z-index:50;`;
            containerRef.current!.appendChild(el);
            return el;
          };
          const labelX = makeLabel('X', '#f87171');
          const labelY = makeLabel('Y', '#4ade80');
          const labelZ = makeLabel('Z', '#60a5fa');
          cleanups.push(() => { labelX.remove(); labelY.remove(); labelZ.remove(); });

          // ── 마우스 (카메라 회전) ──
          let dragging = false;
          let prevX = 0, prevY = 0;

          canvas.addEventListener('mousedown', (e) => {
            if (e.button === 2) {
              dragging = true;
              prevX = e.clientX;
              prevY = e.clientY;
            }
          });
          const onMouseUp = (e: MouseEvent) => {
            if (e.button === 2) dragging = false;
          };
          window.addEventListener('mouseup', onMouseUp);
          cleanups.push(() => window.removeEventListener('mouseup', onMouseUp));

          canvas.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            azim -= (e.clientX - prevX) * 0.3;
            elev -= (e.clientY - prevY) * 0.3;
            prevX = e.clientX;
            prevY = e.clientY;
            syncCamera();
          });

          const onCtx = (e: MouseEvent) => e.preventDefault();
          window.addEventListener('contextmenu', onCtx);
          cleanups.push(() => window.removeEventListener('contextmenu', onCtx));

          // ── 스크롤 줌 ──
          canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (cameraModeRef.current === 'fly') {
              const look = getLookDir(azim, elev);
              const d = -e.deltaY * 0.005 * moveSpeedRef.current;
              camPos.x += look.x * d;
              camPos.y += look.y * d;
              camPos.z += look.z * d;
            } else {
              orbitRadius = Math.max(0.1, orbitRadius * (1 + e.deltaY * 0.001));
            }
            syncCamera();
          }, { passive: false });

          // ── WASDQE ──
          canvas.setAttribute('tabindex', '0');
          canvas.addEventListener('mousedown', () => canvas.focus());
          const keys = new Set<string>();
          const onKD = (e: KeyboardEvent) => { e.preventDefault(); keys.add(e.code); };
          const onKU = (e: KeyboardEvent) => keys.delete(e.code);
          const clearKeys = () => keys.clear();
          canvas.addEventListener('keydown', onKD);
          // keyup / blur / 창 숨김은 window에 바인딩해야 캔버스 포커스 상관없이 잡힘
          // (안 그러면 키 누른 채 모달/버튼 클릭 → 포커스 이탈 시 keyup 놓쳐서 계속 움직이는 버그)
          window.addEventListener('keyup', onKU);
          window.addEventListener('blur', clearKeys);
          document.addEventListener('visibilitychange', clearKeys);
          cleanups.push(() => {
            canvas.removeEventListener('keydown', onKD);
            window.removeEventListener('keyup', onKU);
            window.removeEventListener('blur', clearKeys);
            document.removeEventListener('visibilitychange', clearKeys);
          });

          // ── Update loop ──
          app.on('update', (dt: number) => {
            // WASD
            if (keys.size) {
              const speed = moveSpeedRef.current * 3 * dt * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 5 : 1);
              const look = getLookDir(azim, elev);
              const right = getRightDir(azim);
              const t = cameraModeRef.current === 'fly' ? camPos : orbitTarget;
              if (keys.has('KeyW')) { t.x += look.x * speed; t.y += look.y * speed; t.z += look.z * speed; }
              if (keys.has('KeyS')) { t.x -= look.x * speed; t.y -= look.y * speed; t.z -= look.z * speed; }
              if (keys.has('KeyD')) { t.x += right.x * speed; t.z += right.z * speed; }
              if (keys.has('KeyA')) { t.x -= right.x * speed; t.z -= right.z * speed; }
              if (keys.has('KeyE')) { t.y += speed; }
              if (keys.has('KeyQ')) { t.y -= speed; }
              syncCamera();
            }

            // 기즈모: 화면 좌하단 고정 위치에서 카메라 방향만 따라 회전하는 2D 축 위젯.
            // 각 월드 축 단위벡터를 카메라 right/up 에 정사영해 화면 좌표를 바로 구한다.
            // (월드 좌표 왕복을 안 하므로 부동소수 누적 떨림이 없고, 정수 스냅으로 텍스트도 안 떨린다.)
            {
              const cam = cameraEntity.camera!;
              const cx = 60;
              const cy = canvas.clientHeight - 60;
              const lenPx = 30;       // 화면상 축 길이
              const depth = 1;        // drawLine 용 역투영 평면 (center/tip 동일 depth → 일관)
              const right = cameraEntity.right;
              const up = cameraEntity.up;

              // 월드 축 → 화면 좌표 (정수 스냅).
              const proj = (ax: number, ay: number, az: number): [number, number] => {
                const dr = ax * right.x + ay * right.y + az * right.z;
                const du = ax * up.x + ay * up.y + az * up.z;
                return [Math.round(cx + dr * lenPx), Math.round(cy - du * lenPx)];
              };
              const sX = proj(1, 0, 0);
              const sY = proj(0, 1, 0);
              const sZ = proj(0, 0, 1);

              // drawLine 은 월드 좌표가 필요 — 같은 depth 평면에서 화면 좌표를 역투영.
              const wCenter = new pc.Vec3(); cam.screenToWorld(cx, cy, depth, wCenter);
              const wX = new pc.Vec3(); cam.screenToWorld(sX[0], sX[1], depth, wX);
              const wY = new pc.Vec3(); cam.screenToWorld(sY[0], sY[1], depth, wY);
              const wZ = new pc.Vec3(); cam.screenToWorld(sZ[0], sZ[1], depth, wZ);
              app.drawLine(wCenter, wX, gizmoColorX, false);
              app.drawLine(wCenter, wY, gizmoColorY, false);
              app.drawLine(wCenter, wZ, gizmoColorZ, false);

              labelX.style.left = `${sX[0] + 4}px`; labelX.style.top = `${sX[1] - 6}px`;
              labelY.style.left = `${sY[0] + 4}px`; labelY.style.top = `${sY[1] - 6}px`;
              labelZ.style.left = `${sZ[0] + 4}px`; labelZ.style.top = `${sZ[1] - 6}px`;
            }

            // 외부 등록 콜백
            updateCallbacksRef.current.forEach(cb => cb(dt));
          });

          // ── 터치 ──
          let lastTouchDist = 0;
          let lastTouches: Touch[] = [];
          canvas.addEventListener('touchstart', (e) => {
            lastTouches = Array.from(e.touches);
            if (e.touches.length === 2) {
              const dx = e.touches[0].clientX - e.touches[1].clientX;
              const dy = e.touches[0].clientY - e.touches[1].clientY;
              lastTouchDist = Math.hypot(dx, dy);
            }
          });
          canvas.addEventListener('touchmove', (e) => {
            e.preventDefault();
            if (e.touches.length === 1 && lastTouches.length === 1) {
              azim -= (e.touches[0].clientX - lastTouches[0].clientX) * 0.3;
              elev -= (e.touches[0].clientY - lastTouches[0].clientY) * 0.3;
            } else if (e.touches.length === 2) {
              const dx = e.touches[0].clientX - e.touches[1].clientX;
              const dy = e.touches[0].clientY - e.touches[1].clientY;
              const dist = Math.hypot(dx, dy);
              if (lastTouchDist > 0) {
                if (cameraModeRef.current === 'fly') {
                  const look = getLookDir(azim, elev);
                  const d = (dist - lastTouchDist) * 0.01 * moveSpeedRef.current;
                  camPos.x += look.x * d;
                  camPos.y += look.y * d;
                  camPos.z += look.z * d;
                } else {
                  orbitRadius = Math.max(0.1, orbitRadius * (lastTouchDist / dist));
                }
              }
              lastTouchDist = dist;
            }
            lastTouches = Array.from(e.touches);
            syncCamera();
          }, { passive: false });

          // ── splat 로드/교체 인터페이스 ──
          // 옛 entity는 새 asset이 ready된 시점에 destroy → 화면이 비는 순간이 없다.
          const loadSplat = (url: string, opts?: { preserveCamera?: boolean }): Promise<void> => {
            // 이전 진행 중 로드 취소 (asset.ready 콜백이 더 이상 entity를 만들지 않게 함)
            activeCancel?.();

            let cancelled = false;
            activeCancel = () => { cancelled = true; };

            setLoading(true);
            setError(null);

            const preserveCamera = !!opts?.preserveCamera;

            // reorder=false: PlayCanvas 의 기본 Morton order 재배치 비활성. 활성 시 splatData 의
            // 인덱스가 원본 PLY 순서와 달라져 save 시 alpha mask 가 엉뚱한 splat 에 매핑됨.
            // blob URL 은 확장자가 없어 PC parser 가 형식 판별을 못할 수 있어 filename 힌트 부여.
            const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
            const isBlob = url.startsWith('blob:');
            const filename = isBlob ? 'splat.ply' : (ext ?? 'ply');
            const asset = new pc.Asset('splat', 'gsplat', { url, filename }, { reorder: false } as any);
            app.assets.add(asset);

            return new Promise<void>((resolve, reject) => {
            asset.on('error', (_msg: string, err: Error) => {
              if (cancelled || destroyed) return;
              console.error('[loadSplat] asset error:', err);
              setError(`파일 로드 실패: ${err?.message ?? '알 수 없는 오류'}`);
              setLoading(false);
              reject(err ?? new Error('splat load failed'));
            });

            asset.ready(() => {
              if (cancelled || destroyed) { resolve(); return; }

              // 이전 splat 제거 (이 시점에 이미 새 asset이 GPU에 올라왔으므로 화면이 비지 않음)
              if (splatEntityRef.current) {
                try { splatEntityRef.current.destroy(); } catch {}
                splatEntityRef.current = null;
              }
              splatDataRef.current = null;

              const splatEntity = new pc.Entity('splat');
              // SuperSplat과 동일한 PLY 로드 기본 회전 (SPZ는 (0,0,0), PLY/기타는 Z축 180°)
              const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
              if (ext !== 'spz') {
                splatEntity.setLocalEulerAngles(0, 0, 180);
              }
              splatEntity.addComponent('gsplat', { asset });
              app.root.addChild(splatEntity);
              splatEntityRef.current = splatEntity;

              // preserveCamera 면 카메라 fit 건너뛰고 현재 위치 유지.
              if (!preserveCamera) {
                const mi = (splatEntity as any).gsplat?.meshInstance;
                if (mi?.aabb) {
                  const aabb = mi.aabb;
                  const size = aabb.halfExtents.length();
                  if (cameraModeRef.current === 'fly') {
                    camPos.set(aabb.center.x, aabb.center.y, aabb.center.z + size * 2.5);
                  } else {
                    orbitRadius = size * 2.5;
                    orbitTarget.copy(aabb.center);
                  }
                  azim = 0;
                  elev = 0;
                  syncCamera();
                }
              }

              // PlayCanvas 2.x: gsplatData
              const resource = asset.resource as any;
              const gsplatData = resource?.gsplatData;
              if (gsplatData) {
                const n = gsplatData.numSplats;
                const posX = gsplatData.getProp('x') as Float32Array;
                const posY = gsplatData.getProp('y') as Float32Array;
                const posZ = gsplatData.getProp('z') as Float32Array;
                const colorTex = resource?.streams?.textures?.get('splatColor') ?? null;
                let origColorData: Uint16Array | null = null;
                if (colorTex) {
                  const td = colorTex.lock();
                  if (td) {
                    origColorData = new Uint16Array(td.length);
                    origColorData.set(td);
                    colorTex.unlock();
                  }
                }

                const transformATex = resource?.streams?.textures?.get('transformA') ?? null;
                const transformBTex = resource?.streams?.textures?.get('transformB') ?? null;

                const data: SplatData = {
                  numSplats: n,
                  posX, posY, posZ,
                  colorTexture: colorTex,
                  origColorData,
                  splatEntity,
                  transformATexture: transformATex,
                  transformBTexture: transformBTex,
                  resource,
                  gsplatData,
                };
                splatDataRef.current = data;
                onSplatLoadedRef.current?.(data);
              }

              setLoading(false);
              resolve();
            });

            app.assets.load(asset);
            });
          };

          const clearSplat = () => {
            activeCancel?.();
            activeCancel = null;
            if (splatEntityRef.current) {
              try { splatEntityRef.current.destroy(); } catch {}
              splatEntityRef.current = null;
            }
            splatDataRef.current = null;
            setLoading(false);
            setError(null);
          };

          loadSplatRef.current = loadSplat;
          clearSplatRef.current = clearSplat;

          app.start();

          const ro = new ResizeObserver(() => {
            if (!destroyed && app && containerRef.current) {
              const { clientWidth, clientHeight } = containerRef.current;
              canvas.width = clientWidth * window.devicePixelRatio;
              canvas.height = clientHeight * window.devicePixelRatio;
              app.resizeCanvas();
            }
          });
          ro.observe(containerRef.current!);
          const origDestroy = app.destroy.bind(app);
          app.destroy = () => { ro.disconnect(); origDestroy(); };

          // 두 번째 useEffect (sogUrl-trigger)가 동작할 수 있도록 ready 신호.
          if (!destroyed) setAppReady(true);
        } catch (e: any) {
          if (!destroyed) setError(e?.message ?? '뷰어 초기화에 실패했습니다.');
          setLoading(false);
        }
      })();

      return () => {
        destroyed = true;
        activeCancel?.();
        cleanups.forEach(fn => fn());
        splatDataRef.current = null;
        splatEntityRef.current = null;
        appRef.current = null;
        loadSplatRef.current = null;
        clearSplatRef.current = null;
        updateCallbacksRef.current.clear();
        if (app) { try { app.destroy(); } catch { } }
        if (containerRef.current) {
          const c = containerRef.current.querySelector('canvas');
          if (c) containerRef.current.removeChild(c);
        }
      };
    }, []);

    // ── splat 로드/교체 (sogUrl 변경 시) ──
    // 앱은 그대로 유지하면서 entity만 교체. 옛 entity는 새 asset.ready 시점에 destroy.
    useEffect(() => {
      if (!appReady) return;
      if (sogUrl) {
        // sogUrl prop 변경 → 카메라 fit 모드로 로드. 에러는 내부 setError 가 처리.
        void loadSplatRef.current?.(sogUrl);
      } else {
        clearSplatRef.current?.();
      }
    }, [sogUrl, appReady]);

    const toggleMode = () => {
      const next = cameraMode === 'fly' ? 'orbit' : 'fly';
      if (next === 'orbit') syncOrbitFromFlyRef.current();
      setCameraMode(next);
      cameraModeRef.current = next;
    };

    const toggleFullscreen = () => {
      const root = rootRef.current;
      if (!root) return;
      if (document.fullscreenElement) void document.exitFullscreen();
      else void root.requestFullscreen();
    };
    useEffect(() => {
      const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
      document.addEventListener('fullscreenchange', onFsChange);
      return () => document.removeEventListener('fullscreenchange', onFsChange);
    }, []);

    return (
      <div ref={rootRef} className="relative w-full h-full min-h-[400px] bg-[#141414]">
        <div ref={containerRef} className="w-full h-full relative" />

        {loading && sogUrl && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#141414]/90 gap-3">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-gray-400">3DGS 파일 로딩 중...</p>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#141414]/90">
            <div className="text-center px-6">
              <p className="text-red-400 text-sm mb-1">로드 실패</p>
              <p className="text-gray-500 text-xs">{error}</p>
            </div>
          </div>
        )}

        {/* 도구 UI 슬롯 — loading state 와 무관하게 항상 mount 유지.
            (loading 조건에 묶이면 PLY reload 시 children 이 전부 unmount → 자식 컴포넌트 useState 초기화.
             로딩 인디케이터는 위의 별도 overlay 가 시각적으로 가림.) */}
        {!error && children}

        {/* 하단 카메라 컨트롤 */}
        {!loading && !error && (
          <div className="absolute bottom-3 right-3 flex items-center gap-2 bg-black/60 text-gray-400 text-xs px-3 py-2 rounded select-none">
            <button onClick={toggleMode} className="px-2 py-0.5 bg-gray-700 hover:bg-gray-600 text-white rounded cursor-pointer">
              {cameraMode === 'fly' ? 'Fly' : 'Orbit'}
            </button>
            <span className="pointer-events-none">이동속도</span>
            <input type="range" min="0.05" max="2" step="0.05" value={moveSpeed}
              onChange={(e) => { const v = parseFloat(e.target.value); setMoveSpeed(v); moveSpeedRef.current = v; }}
              onPointerUp={() => canvasRef.current?.focus()}
              className="w-20 h-1 accent-blue-500 cursor-pointer" />
            <span className={`pointer-events-none w-10 text-right font-mono ${shiftActive ? 'text-blue-400 font-bold' : ''}`}>
              {(moveSpeed * (shiftActive ? 5 : 1)).toFixed(2)}
            </span>
            <span className="pointer-events-none ml-1 text-gray-500">
              {cameraMode === 'fly'
                ? '| 우클릭: 회전 | WASD: 이동 | QE: 상하 | 스크롤: 전후'
                : '| 우클릭: 회전 | WASD: 이동 | QE: 상하 | 스크롤: 줌'}
            </span>
            <button
              onClick={toggleFullscreen}
              title={isFullscreen ? '전체화면 해제 (Esc)' : '전체화면'}
              className="ml-1 p-1 rounded text-gray-300 hover:text-white hover:bg-white/10 cursor-pointer"
            >
              {isFullscreen ? (
                // 전체화면 해제 — 안쪽 화살표.
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 3v6H3M21 9h-6V3M3 15h6v6M15 21v-6h6" />
                </svg>
              ) : (
                // 전체화면 — 네 모서리 확장.
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3H3v5M21 8V3h-5M16 21h5v-5M3 16v5h5" />
                </svg>
              )}
            </button>
          </div>
        )}
      </div>
    );
  },
);

SplatViewerCore.displayName = 'SplatViewerCore';
export default SplatViewerCore;
