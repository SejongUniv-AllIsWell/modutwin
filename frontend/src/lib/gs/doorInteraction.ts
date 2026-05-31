/**
 * 층 뷰어 문 상호작용 — hover 하이라이트 + 좌클릭 열기/닫기 (게임식).
 *
 * 동작:
 *  - pointermove → 카메라에서 마우스 방향 ray → 각 문의 live world quad (4 코너) 와 ray-삼각형 교차.
 *    가장 가까운 문을 hover 대상으로. hover 시 노란 외곽선 + 커서 pointer.
 *  - 좌클릭 → hover 중인 문을 열기/닫기 토글. 힌지 축 기준 90° 회전 애니메이션.
 *
 * 좌표 정합: 문 wrapper (moduleDoor_*) 의 자식 mesh/splat 은 local Z-180 (resetPlyLocalFrame) 을 이미 갖는다.
 *   즉 자식 지오메트리는 World 프레임 (= Z-180 · A'+Y). 따라서 wrapper 회전을 World 프레임 힌지 축으로
 *   직접 걸면 된다 (에디터처럼 baseRot 합성 불필요).
 *     worldCorner = wrapper.getWorldTransform() · (Z-180 · cornerAY)
 *     wrapperLocalRot = quat(axisWorld, angle)
 *     wrapperLocalPos = originWorld − quat·originWorld   (힌지점 고정)
 */

type Vec3 = [number, number, number];

export interface DoorHandle {
  id: string;
  wrapper: any;                 // moduleDoor wrapper entity — 회전 대상
  corners: Vec3[];              // 4 코너 (A'+Y 저장 프레임)
  hingeEdge: number;            // 0..3 — 힌지 변 시작 코너 인덱스
  swing: number;                // ±1 (저장된 doorSwing)
  normalInward: Vec3;           // 방 안쪽 normal (A'+Y 프레임)
}

export interface DoorInteractionController {
  add(handle: DoorHandle): void;
  /** wrapper 로 등록 해제 (오버레이 record 정리 시). */
  removeByWrapper(wrapper: any): void;
  clear(): void;
  dispose(): void;
}

interface DoorState {
  id: string;
  wrapper: any;
  z180Corners: Vec3[];     // Z-180 적용된 4 코너 (World 프레임, wrapper local)
  axisWorld: Vec3;         // 힌지 단위축 (World)
  originWorld: Vec3;       // 힌지 시작점 (World)
  openAngleRad: number;    // 열린 상태 목표각 (부호 포함)
  isOpen: boolean;
  anim: { start: number; duration: number; from: number; to: number } | null;
  curAngle: number;
}

const OPEN_ANGLE = Math.PI / 2; // 90°
const ANIM_MS = 700;
const HILITE: [number, number, number, number] = [1, 0.85, 0.2, 1];

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function z180(v: Vec3): Vec3 {
  return [-v[0], -v[1], v[2]];
}

/** 힌지 축/원점/열림 부호 산출 (A'+Y 프레임 계산 → World 변환). */
function computeHinge(h: DoorHandle): { axisWorld: Vec3; originWorld: Vec3; openAngleRad: number } {
  const c = h.corners;
  const h1 = h.hingeEdge % 4;
  const h2 = (h.hingeEdge + 1) % 4;
  const start = c[h1];
  const end = c[h2];
  const ax = end[0] - start[0], ay = end[1] - start[1], az = end[2] - start[2];
  const aLen = Math.hypot(ax, ay, az) || 1;
  const axisA: Vec3 = [ax / aLen, ay / aLen, az / aLen];

  // swing 부호: 힌지 아닌 코너 P 에 대해 cross(axis, P-start) 가 벽 바깥 normal 과
  // 같은 방향이면 +θ 가 P 를 바깥으로 보냄 → 안쪽(+swing)으로 열려면 -θ.
  const otherIdx = [0, 1, 2, 3].find(i => i !== h1 && i !== h2) ?? ((h.hingeEdge + 2) % 4);
  const P = c[otherIdx];
  const dx = P[0] - start[0], dy = P[1] - start[1], dz = P[2] - start[2];
  const crossX = axisA[1] * dz - axisA[2] * dy;
  const crossY = axisA[2] * dx - axisA[0] * dz;
  const crossZ = axisA[0] * dy - axisA[1] * dx;
  // normalInward 는 방 안쪽 → 바깥 normal = -normalInward.
  const wnOut: Vec3 = [-h.normalInward[0], -h.normalInward[1], -h.normalInward[2]];
  const dotCN = crossX * wnOut[0] + crossY * wnOut[1] + crossZ * wnOut[2];
  const insideSign = dotCN > 0 ? -1 : 1;
  const swing = h.swing === 0 || Number.isNaN(h.swing) ? 1 : h.swing;
  const openAngleRad = swing * insideSign * OPEN_ANGLE;

  return {
    axisWorld: z180(axisA),
    originWorld: z180(start),
    openAngleRad,
  };
}

/** Möller–Trumbore. ray (o,d) 와 삼각형 (a,b,c) 교차 시 t (>0) 반환, 없으면 null. */
function rayTri(o: Vec3, d: Vec3, a: Vec3, b: Vec3, cc: Vec3): number | null {
  const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
  const e2x = cc[0] - a[0], e2y = cc[1] - a[1], e2z = cc[2] - a[2];
  const px = d[1] * e2z - d[2] * e2y;
  const py = d[2] * e2x - d[0] * e2z;
  const pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-9) return null;
  const inv = 1 / det;
  const tx = o[0] - a[0], ty = o[1] - a[1], tz = o[2] - a[2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -1e-6 || u > 1 + 1e-6) return null;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < -1e-6 || u + v > 1 + 1e-6) return null;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > 1e-4 ? t : null;
}

export function createDoorInteraction(opts: {
  pc: any;
  app: any;
  getCamera: () => any | null;
  canvas: HTMLCanvasElement;
  onUpdate: (cb: () => void) => () => void;
}): DoorInteractionController {
  const { pc, app, getCamera, canvas } = opts;
  const doors: DoorState[] = [];
  let hoveredId: string | null = null;

  const tmpWorld = new pc.Vec3();
  const tmpFar = new pc.Vec3();

  // wrapper world transform 으로 z180 코너 → floor world 코너.
  function liveCorners(s: DoorState): Vec3[] {
    const m = s.wrapper.getWorldTransform();
    return s.z180Corners.map(c => {
      tmpWorld.set(c[0], c[1], c[2]);
      m.transformPoint(tmpWorld, tmpWorld);
      return [tmpWorld.x, tmpWorld.y, tmpWorld.z] as Vec3;
    });
  }

  function pickAt(clientX: number, clientY: number): DoorState | null {
    const cam = getCamera();
    if (!cam?.camera) return null;
    const rect = canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const camPos = cam.getPosition();
    const o: Vec3 = [camPos.x, camPos.y, camPos.z];
    cam.camera.screenToWorld(sx, sy, cam.camera.farClip, tmpFar);
    let dx = tmpFar.x - o[0], dy = tmpFar.y - o[1], dz = tmpFar.z - o[2];
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;
    const d: Vec3 = [dx, dy, dz];

    let best: DoorState | null = null;
    let bestT = Infinity;
    for (const s of doors) {
      if (!s.wrapper || s.wrapper._destroyed) continue;
      const q = liveCorners(s); // [TL,TR,BR,BL]
      const t1 = rayTri(o, d, q[0], q[1], q[2]);
      const t2 = rayTri(o, d, q[0], q[2], q[3]);
      const t = Math.min(t1 ?? Infinity, t2 ?? Infinity);
      if (t < bestT) { bestT = t; best = s; }
    }
    return best;
  }

  const onMove = (e: PointerEvent) => {
    const hit = pickAt(e.clientX, e.clientY);
    hoveredId = hit?.id ?? null;
    canvas.style.cursor = hit ? 'pointer' : '';
  };

  // 카메라 드래그(시작점이 문 위)와 문 토글 클릭을 구분 — down/up 이동량이 임계 미만일 때만 클릭.
  let downX = 0, downY = 0, downBtn = -1;
  const CLICK_SLOP = 5; // px

  const onDown = (e: PointerEvent) => {
    downBtn = e.button;
    downX = e.clientX;
    downY = e.clientY;
  };

  const onUp = (e: PointerEvent) => {
    if (downBtn !== 0 || e.button !== 0) return;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > CLICK_SLOP) return; // 드래그 → 무시
    const hit = pickAt(e.clientX, e.clientY);
    if (!hit) return;
    const target = hit.isOpen ? 0 : hit.openAngleRad;
    hit.anim = { start: performance.now(), duration: ANIM_MS, from: hit.curAngle, to: target };
    hit.isOpen = !hit.isOpen;
  };

  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);

  // 매 프레임: 애니메이션 진행 + hover 외곽선.
  const offUpdate = opts.onUpdate(() => {
    const now = performance.now();
    for (const s of doors) {
      if (!s.wrapper || s.wrapper._destroyed) continue;
      if (s.anim) {
        const tNorm = Math.min(1, (now - s.anim.start) / s.anim.duration);
        const u = easeInOutCubic(tNorm);
        s.curAngle = s.anim.from + (s.anim.to - s.anim.from) * u;
        applyAngle(s);
        if (tNorm >= 1) s.anim = null;
      }
    }
    if (hoveredId) {
      const s = doors.find(d => d.id === hoveredId);
      if (s && s.wrapper && !s.wrapper._destroyed) {
        const q = liveCorners(s);
        const col = new pc.Color(HILITE[0], HILITE[1], HILITE[2], HILITE[3]);
        for (let i = 0; i < 4; i++) {
          const a = q[i], b = q[(i + 1) % 4];
          app.drawLine(new pc.Vec3(a[0], a[1], a[2]), new pc.Vec3(b[0], b[1], b[2]), col, false);
        }
      }
    }
  });

  function applyAngle(s: DoorState) {
    const half = s.curAngle / 2;
    const sH = Math.sin(half), cH = Math.cos(half);
    const qx = s.axisWorld[0] * sH, qy = s.axisWorld[1] * sH, qz = s.axisWorld[2] * sH, qw = cH;
    // rotated origin = q · origin · q⁻¹
    const o = s.originWorld;
    const rot = new pc.Quat(qx, qy, qz, qw);
    const ov = new pc.Vec3(o[0], o[1], o[2]);
    const rotated = new pc.Vec3();
    rot.transformVector(ov, rotated);
    s.wrapper.setLocalRotation(qx, qy, qz, qw);
    s.wrapper.setLocalPosition(o[0] - rotated.x, o[1] - rotated.y, o[2] - rotated.z);
  }

  return {
    add(h: DoorHandle) {
      if (doors.some(d => d.id === h.id)) return;
      const hinge = computeHinge(h);
      doors.push({
        id: h.id,
        wrapper: h.wrapper,
        z180Corners: h.corners.map(z180),
        axisWorld: hinge.axisWorld,
        originWorld: hinge.originWorld,
        openAngleRad: hinge.openAngleRad,
        isOpen: false,
        anim: null,
        curAngle: 0,
      });
    },
    removeByWrapper(wrapper: any) {
      for (let i = doors.length - 1; i >= 0; i--) {
        if (doors[i].wrapper === wrapper) {
          if (hoveredId === doors[i].id) hoveredId = null;
          doors.splice(i, 1);
        }
      }
    },
    clear() {
      doors.length = 0;
      hoveredId = null;
    },
    dispose() {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.style.cursor = '';
      offUpdate();
      doors.length = 0;
      hoveredId = null;
    },
  };
}
