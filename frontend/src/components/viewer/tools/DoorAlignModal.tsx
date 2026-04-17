'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SplatViewerCoreRef } from '../SplatViewerCore';

interface Props {
  coreRef: React.RefObject<SplatViewerCoreRef>;
  uploadId: string;
  currentUrl: string;
  onDone: (newUrl: string) => void;
  onClose: () => void;
}

type Vec3 = [number, number, number];

const PAIR_COUNT = 4;

/**
 * 문(door) 기반 강체 정합 모달.
 *
 * 동작:
 *  - 사용자가 PAIR_COUNT(4)개 "Pick" 버튼 중 하나를 누르면 arm 모드가 되어
 *    다음 캔버스 클릭에서 가장 가까운 splat의 raw 위치를 capture한다.
 *  - 각 행에는 target 위치 3개(x, y, z)를 text input으로 입력한다.
 *  - Apply 시 PLY를 다시 fetch → Kabsch로 R, t 추정 → scene에 적용 → presigned
 *    PUT으로 업로드 → reload URL 콜백.
 *
 * 참고:
 *  - source/target 모두 "raw PLY 프레임" 기준. 뷰어는 PLY에 대해 Z축 180° 회전을
 *    적용하지만, 여기서는 raw 좌표 그대로 사용 → 정합도 raw 프레임에서 성립하므로
 *    PLY를 다시 불러와도 일관성이 유지된다. (뷰어가 동일한 Z-180을 그대로 적용함)
 */
export default function DoorAlignModal({
  coreRef, uploadId, currentUrl, onDone, onClose,
}: Props) {
  const [source, setSource] = useState<Array<Vec3 | null>>(() => Array(PAIR_COUNT).fill(null));
  const [target, setTarget] = useState<Array<[string, string, string]>>(
    () => Array(PAIR_COUNT).fill(['', '', '']),
  );
  const [armedRow, setArmedRow] = useState<number | null>(null);
  const [rmsd, setRmsd] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef(source);
  useEffect(() => { sourceRef.current = source; }, [source]);

  // ── 가장 가까운 splat (raw 프레임) 선택 ──
  const pickNearestSplat = useCallback((mouseX: number, mouseY: number): Vec3 | null => {
    const core = coreRef.current;
    const cam = core?.getCamera()?.camera;
    const pc = core?.getPC();
    const sd = core?.getSplatData();
    if (!core || !cam || !pc || !sd) return null;

    const near = new pc.Vec3(), far = new pc.Vec3();
    cam.screenToWorld(mouseX, mouseY, cam.nearClip, near);
    cam.screenToWorld(mouseX, mouseY, cam.farClip, far);
    const dx = far.x - near.x, dy = far.y - near.y, dz = far.z - near.z;
    const rl = Math.hypot(dx, dy, dz) || 1;
    const rdx = dx/rl, rdy = dy/rl, rdz = dz/rl;

    // splat entity의 world transform — raw → world 변환
    const m = sd.splatEntity.getWorldTransform().data;
    let bestIdx = -1;
    let bestD = Infinity;
    const N = sd.numSplats;
    for (let i = 0; i < N; i++) {
      const rx = sd.posX[i], ry = sd.posY[i], rz = sd.posZ[i];
      // world = m * raw
      const wx = m[0]*rx + m[4]*ry + m[8]*rz + m[12];
      const wy = m[1]*rx + m[5]*ry + m[9]*rz + m[13];
      const wz = m[2]*rx + m[6]*ry + m[10]*rz + m[14];
      // 점-선 수직거리 (near가 선상 점, rd가 방향)
      const ex = wx - near.x, ey = wy - near.y, ez = wz - near.z;
      const proj = ex*rdx + ey*rdy + ez*rdz;
      if (proj < 0) continue;
      const px = ex - rdx*proj, py = ey - rdy*proj, pz = ez - rdz*proj;
      const d2 = px*px + py*py + pz*pz;
      if (d2 < bestD) { bestD = d2; bestIdx = i; }
    }
    if (bestIdx < 0) return null;
    return [sd.posX[bestIdx], sd.posY[bestIdx], sd.posZ[bestIdx]];
  }, [coreRef]);

  // ── 캔버스에 click 리스너 등록/해제 ──
  useEffect(() => {
    if (armedRow === null) return;
    const core = coreRef.current;
    const canvas = core?.getCanvas();
    if (!canvas) return;

    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      if (mx < 0 || mx > rect.width || my < 0 || my > rect.height) return;
      const picked = pickNearestSplat(mx, my);
      if (!picked) { setError('splat을 찾지 못했습니다'); return; }
      setSource(prev => {
        const next = [...prev];
        next[armedRow] = picked;
        return next;
      });
      setArmedRow(null);
      setError(null);
    };
    canvas.addEventListener('mouseup', onMouseUp);
    return () => canvas.removeEventListener('mouseup', onMouseUp);
  }, [armedRow, coreRef, pickNearestSplat]);

  // ── target XYZ 파싱 ──
  const parseTarget = useCallback((): Vec3[] | null => {
    const out: Vec3[] = [];
    for (let i = 0; i < PAIR_COUNT; i++) {
      const [sx, sy, sz] = target[i];
      const x = parseFloat(sx), y = parseFloat(sy), z = parseFloat(sz);
      if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) return null;
      out.push([x, y, z]);
    }
    return out;
  }, [target]);

  const computePreview = useCallback(async () => {
    setError(null); setRmsd(null);
    if (source.some(s => s === null)) { setError('모든 source 꼭짓점을 먼저 선택하세요'); return; }
    const tgt = parseTarget();
    if (!tgt) { setError('target 좌표가 올바르지 않습니다'); return; }
    try {
      const { matchCorners } = await import('@/lib/alignment');
      const src = new Float64Array(PAIR_COUNT * 3);
      const dst = new Float64Array(PAIR_COUNT * 3);
      for (let i = 0; i < PAIR_COUNT; i++) {
        const s = source[i]!; src[i*3]=s[0]; src[i*3+1]=s[1]; src[i*3+2]=s[2];
        const t = tgt[i]; dst[i*3]=t[0]; dst[i*3+1]=t[1]; dst[i*3+2]=t[2];
      }
      const fit = matchCorners(src, dst);
      setRmsd(fit.rmsd);
    } catch (e: any) {
      setError(`추정 실패: ${e.message || e}`);
    }
  }, [source, parseTarget]);

  const applyAndSave = useCallback(async () => {
    setError(null);
    if (source.some(s => s === null)) { setError('모든 source 꼭짓점을 먼저 선택하세요'); return; }
    const tgt = parseTarget();
    if (!tgt) { setError('target 좌표가 올바르지 않습니다'); return; }
    setRunning(true);
    try {
      const [{ fetchAndParsePly, serializePly }, { matchCorners, applyRigidToScene }] = await Promise.all([
        import('@/lib/ply'),
        import('@/lib/alignment'),
      ]);
      const { api } = await import('@/lib/api');

      const scene = await fetchAndParsePly(currentUrl);

      const src = new Float64Array(PAIR_COUNT * 3);
      const dst = new Float64Array(PAIR_COUNT * 3);
      for (let i = 0; i < PAIR_COUNT; i++) {
        const s = source[i]!; src[i*3]=s[0]; src[i*3+1]=s[1]; src[i*3+2]=s[2];
        const t = tgt[i]; dst[i*3]=t[0]; dst[i*3+1]=t[1]; dst[i*3+2]=t[2];
      }
      const fit = matchCorners(src, dst);
      setRmsd(fit.rmsd);

      applyRigidToScene(scene, fit);
      const bytes = serializePly(scene);

      const urlReq = await api.post<{ put_url: string; get_url: string }>(
        '/refine/refined-upload-url',
        { upload_id: uploadId, filename: 'aligned.ply' },
      );
      const put = await fetch(urlReq.put_url, {
        method: 'PUT',
        body: bytes,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      if (!put.ok) throw new Error(`MinIO PUT failed: ${put.status}`);

      onDone(urlReq.get_url);
    } catch (e: any) {
      setError(`정합 실패: ${e.message || e}`);
    } finally {
      setRunning(false);
    }
  }, [source, parseTarget, currentUrl, uploadId, onDone]);

  const clearRow = (idx: number) => {
    setSource(prev => { const n = [...prev]; n[idx] = null; return n; });
    setRmsd(null);
  };

  return (
    <div className="fixed right-3 top-3 z-50 bg-gray-900/95 border border-gray-700 rounded-lg shadow-2xl text-white text-xs select-none" style={{width: 420}}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700">
        <div className="font-bold">문 기반 정합 (수동 4점)</div>
        <button onClick={onClose} className="text-gray-400 hover:text-white cursor-pointer">✕</button>
      </div>
      <div className="p-3 space-y-2">
        <div className="text-gray-400 text-[10px] leading-tight">
          각 행의 "Pick"을 누른 뒤 뷰어의 문 꼭짓점을 클릭하세요. target 좌표는 정합 후
          배치될 raw-frame 위치 (x y z)를 입력합니다. 4쌍이 모두 채워지면 Compute로
          잔차(RMSD)를 확인하고 Apply로 변환을 적용해 정제 결과로 저장합니다.
        </div>

        <div className="space-y-1.5">
          {Array.from({length: PAIR_COUNT}).map((_, i) => {
            const s = source[i];
            return (
              <div key={i} className="flex items-center gap-1.5 text-[11px]">
                <div className="w-6 text-gray-500 text-right">#{i+1}</div>
                <button
                  onClick={() => setArmedRow(armedRow === i ? null : i)}
                  className={`px-2 py-1 rounded cursor-pointer text-[10px] font-bold ${
                    armedRow === i
                      ? 'bg-yellow-500 text-black'
                      : s ? 'bg-green-700 hover:bg-green-600' : 'bg-blue-600 hover:bg-blue-500'
                  }`}
                >{armedRow === i ? 'Click viewer' : s ? 'Re-pick' : 'Pick'}</button>
                <div className="flex-1 font-mono text-gray-300 truncate">
                  {s ? `${s[0].toFixed(2)}, ${s[1].toFixed(2)}, ${s[2].toFixed(2)}` : '(미선택)'}
                </div>
                {s && <button onClick={() => clearRow(i)} className="text-gray-500 hover:text-red-400 cursor-pointer text-[10px]">×</button>}
              </div>
            );
          })}
        </div>

        <div className="border-t border-gray-700 pt-2">
          <div className="text-gray-400 text-[10px] mb-1">Target (raw x, y, z)</div>
          <div className="space-y-1">
            {Array.from({length: PAIR_COUNT}).map((_, i) => (
              <div key={i} className="flex items-center gap-1">
                <div className="w-6 text-gray-500 text-right text-[11px]">#{i+1}</div>
                {[0,1,2].map(j => (
                  <input key={j}
                    value={target[i][j]}
                    onChange={e => setTarget(prev => {
                      const n = prev.map(r => [...r] as [string, string, string]);
                      n[i][j] = e.target.value;
                      return n;
                    })}
                    placeholder={['x','y','z'][j]}
                    className="flex-1 bg-gray-800 border border-gray-600 rounded px-1.5 py-0.5 text-[11px] font-mono"
                  />
                ))}
              </div>
            ))}
          </div>
        </div>

        {error && <div className="text-red-400 text-[11px]">{error}</div>}
        {rmsd !== null && (
          <div className="text-[11px]">
            RMSD: <span className={`font-mono font-bold ${rmsd < 0.02 ? 'text-green-400' : rmsd < 0.1 ? 'text-yellow-400' : 'text-red-400'}`}>
              {rmsd.toFixed(4)}
            </span> m
          </div>
        )}

        <div className="flex gap-1.5 pt-1">
          <button onClick={computePreview} disabled={running}
            className="flex-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 rounded cursor-pointer text-xs">
            Compute
          </button>
          <button onClick={applyAndSave} disabled={running}
            className="flex-1 px-3 py-1.5 bg-green-600 hover:bg-green-500 disabled:bg-gray-600 rounded cursor-pointer text-xs font-bold">
            {running ? '처리 중...' : 'Apply & Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
