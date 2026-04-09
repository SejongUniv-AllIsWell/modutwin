'use client';

import {
  useEffect, useRef, useState, useCallback,
  forwardRef, useImperativeHandle,
} from 'react';

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
  getSplatData: () => SplatData | null;
  getPC: () => any | null;
  float2Half: (v: number) => number;
  half2Float: (h: number) => number;
  /** PlayCanvas update loop에 콜백 등록. 해제 함수 반환 */
  onUpdate: (cb: (dt: number) => void) => () => void;
  /** PlayCanvas app.drawLine 래퍼 */
  drawLine: (a: [number, number, number], b: [number, number, number], color: [number, number, number, number], depthTest?: boolean) => void;
}

interface SplatViewerCoreProps {
  sogUrl: string;
  onSplatLoaded?: (data: SplatData) => void;
  children?: React.ReactNode;
}

type CameraMode = 'fly' | 'orbit';

const DEG2RAD = Math.PI / 180;

// half2Float 구현 (PlayCanvas에 없음)
function _half2Float(h: number): number {
  const s = (h >> 15) & 0x1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) {
    if (m === 0) return s ? -0 : 0;
    return (s ? -1 : 1) * Math.pow(2, -14) * (m / 1024);
  }
  if (e === 31) return m ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + m / 1024);
}

const SplatViewerCore = forwardRef<SplatViewerCoreRef, SplatViewerCoreProps>(
  ({ sogUrl, onSplatLoaded, children }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [cameraMode, setCameraMode] = useState<CameraMode>('fly');
    const [moveSpeed, setMoveSpeed] = useState(0.5);

    const cameraModeRef = useRef<CameraMode>('fly');
    const moveSpeedRef = useRef(0.5);
    const appRef = useRef<any>(null);
    const cameraEntityRef = useRef<any>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const splatDataRef = useRef<SplatData | null>(null);
    const syncOrbitFromFlyRef = useRef<() => void>(() => {});
    const float2HalfRef = useRef<(v: number) => number>((v) => v);
    const updateCallbacksRef = useRef<Set<(dt: number) => void>>(new Set());
    const pcRef = useRef<any>(null);

    // ── 외부 노출 API ──
    useImperativeHandle(ref, () => ({
      getApp: () => appRef.current,
      getCamera: () => cameraEntityRef.current,
      getCanvas: () => canvasRef.current,
      getContainer: () => containerRef.current,
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
    }));

    // ── PlayCanvas 초기화 ──
    useEffect(() => {
      if (!containerRef.current || !sogUrl) return;

      let app: any = null;
      let destroyed = false;
      const cleanups: (() => void)[] = [];

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
            graphicsDeviceOptions: { antialias: false },
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

          const calcForwardVec = (a: number, e: number) => {
            const ex = e * DEG2RAD, ey = a * DEG2RAD;
            const s1 = Math.sin(-ex), c1 = Math.cos(-ex), s2 = Math.sin(-ey), c2 = Math.cos(-ey);
            return new pc.Vec3(-c1 * s2, s1, c1 * c2);
          };
          const getLookDir = (a: number, e: number) => {
            const f = calcForwardVec(a, e);
            return new pc.Vec3(-f.x, -f.y, -f.z);
          };
          const getRightDir = (a: number) => {
            const ey = a * DEG2RAD;
            return new pc.Vec3(Math.cos(ey), 0, -Math.sin(ey));
          };

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
            el.style.cssText = `position:absolute;pointer-events:none;font-size:11px;font-weight:bold;color:${color};text-shadow:0 0 3px #000;`;
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
          canvas.addEventListener('keydown', onKD);
          canvas.addEventListener('keyup', onKU);
          cleanups.push(() => {
            canvas.removeEventListener('keydown', onKD);
            canvas.removeEventListener('keyup', onKU);
          });

          // ── Update loop ──
          app.on('update', (dt: number) => {
            // 기즈모
            {
              const cam = cameraEntity.camera!;
              const gizmoScreenX = 60;
              const gizmoScreenY = canvas.clientHeight - 60;
              const gizmoCenter = new pc.Vec3();
              cam.screenToWorld(gizmoScreenX, gizmoScreenY, 2, gizmoCenter);

              const refPoint = new pc.Vec3();
              cam.screenToWorld(gizmoScreenX + 30, gizmoScreenY, 2, refPoint);
              const axisLen = gizmoCenter.distance(refPoint);

              const tipX = new pc.Vec3(gizmoCenter.x + axisLen, gizmoCenter.y, gizmoCenter.z);
              const tipY = new pc.Vec3(gizmoCenter.x, gizmoCenter.y + axisLen, gizmoCenter.z);
              const tipZ = new pc.Vec3(gizmoCenter.x, gizmoCenter.y, gizmoCenter.z + axisLen);

              app.drawLine(gizmoCenter, tipX, gizmoColorX, false);
              app.drawLine(gizmoCenter, tipY, gizmoColorY, false);
              app.drawLine(gizmoCenter, tipZ, gizmoColorZ, false);

              const scrPos = new pc.Vec3();
              cam.worldToScreen(tipX, scrPos);
              labelX.style.left = `${scrPos.x + 4}px`; labelX.style.top = `${scrPos.y - 6}px`;
              cam.worldToScreen(tipY, scrPos);
              labelY.style.left = `${scrPos.x + 4}px`; labelY.style.top = `${scrPos.y - 6}px`;
              cam.worldToScreen(tipZ, scrPos);
              labelZ.style.left = `${scrPos.x + 4}px`; labelZ.style.top = `${scrPos.y - 6}px`;
            }

            // WASD
            if (keys.size) {
              const speed = moveSpeedRef.current * 3 * dt;
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

          // ── GSplat 로딩 ──
          const asset = new pc.Asset('splat', 'gsplat', { url: sogUrl });
          app.assets.add(asset);
          asset.on('error', (_: string, err: Error) => {
            if (!destroyed) setError(`파일 로드 실패: ${err?.message ?? '알 수 없는 오류'}`);
            setLoading(false);
          });

          asset.ready(() => {
            if (destroyed) return;

            const splatEntity = new pc.Entity('splat');
            splatEntity.addComponent('gsplat', { asset });
            app.root.addChild(splatEntity);

            // 카메라 초기 위치
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
              onSplatLoaded?.(data);
            }

            setLoading(false);
          });

          app.assets.load(asset);
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
        } catch (e: any) {
          if (!destroyed) setError(e?.message ?? '뷰어 초기화에 실패했습니다.');
          setLoading(false);
        }
      })();

      return () => {
        destroyed = true;
        cleanups.forEach(fn => fn());
        splatDataRef.current = null;
        appRef.current = null;
        updateCallbacksRef.current.clear();
        if (app) { try { app.destroy(); } catch { } }
        if (containerRef.current) {
          const c = containerRef.current.querySelector('canvas');
          if (c) containerRef.current.removeChild(c);
        }
      };
    }, [sogUrl, onSplatLoaded]);

    const toggleMode = () => {
      const next = cameraMode === 'fly' ? 'orbit' : 'fly';
      if (next === 'orbit') syncOrbitFromFlyRef.current();
      setCameraMode(next);
      cameraModeRef.current = next;
    };

    return (
      <div className="relative w-full h-full min-h-[400px] bg-[#141414]">
        <div ref={containerRef} className="w-full h-full relative" />

        {loading && (
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

        {/* 도구 UI 슬롯 */}
        {!loading && !error && children}

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
            <span className="pointer-events-none w-8 text-right">{moveSpeed.toFixed(1)}</span>
            <span className="pointer-events-none ml-1 text-gray-500">
              {cameraMode === 'fly'
                ? '| 우클릭: 회전 | WASD: 이동 | QE: 상하 | 스크롤: 전후'
                : '| 우클릭: 회전 | WASD: 이동 | QE: 상하 | 스크롤: 줌'}
            </span>
          </div>
        )}
      </div>
    );
  },
);

SplatViewerCore.displayName = 'SplatViewerCore';
export default SplatViewerCore;
