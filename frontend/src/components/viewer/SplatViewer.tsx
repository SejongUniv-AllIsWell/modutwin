'use client';

import { useRef, useState, useCallback, Suspense, lazy } from 'react';
import SplatViewerCore, { SplatViewerCoreRef } from './SplatViewerCore';
import { useGaussianSelector } from './tools/useGaussianSelector';
import { useDoorAnimation } from './tools/useDoorAnimation';
import { usePivotEditor } from './tools/usePivotEditor';
import { useTransformTool } from './tools/useTransformTool';

const DoorAlignModal = lazy(() => import('./tools/DoorAlignModal'));

interface SplatViewerProps {
  sogUrl: string;
  mode: 'edit' | 'readonly';
  uploadId?: string;
  onSelectionDone?: (indices: number[]) => void;
}

export default function SplatViewer({ sogUrl, mode, uploadId, onSelectionDone }: SplatViewerProps) {
  const coreRef = useRef<SplatViewerCoreRef>(null);
  const [currentUrl, setCurrentUrl] = useState(sogUrl);
  const [reloadKey, setReloadKey] = useState(0);
  const [doorAlignOpen, setDoorAlignOpen] = useState(false);

  const reloadWithUrl = useCallback((newUrl: string) => {
    setCurrentUrl(newUrl);
    setReloadKey(k => k + 1);
  }, []);
  const selector = useGaussianSelector(coreRef, { onSelectionDone });
  const { openDoor, closeDoor } = useDoorAnimation(coreRef);
  const pivotEditor = usePivotEditor(coreRef);
  const transform = useTransformTool(coreRef);
  const [doorIndices, setDoorIndices] = useState<number[] | null>(null);

  const handleStartTransform = () => {
    const indices = selector.selectedIndices();
    if (indices.length === 0) return;
    transform.startTransform(indices);
  };

  const handleSetDoor = () => {
    const indices = selector.selectedIndices();
    if (indices.length === 0) return;
    setDoorIndices(indices);
  };

  const handlePivotEdit = () => {
    if (!doorIndices) return;
    pivotEditor.startEditing(doorIndices);
  };

  const handleOpen = () => {
    if (!doorIndices) return;
    const pivotData = pivotEditor.getPivotForAnimation();
    openDoor(doorIndices, {
      pivotAxis: pivotData?.pivotAxis ?? 'y',
      angleDeg: 90,
      durationSec: 1.0,
      pivot: pivotData?.pivot,
    });
  };

  const handleClose = () => {
    closeDoor({ durationSec: 1.0 });
  };

  return (
    <SplatViewerCore key={reloadKey} ref={coreRef} sogUrl={currentUrl} onSplatLoaded={selector.onSplatLoaded}>
      {mode === 'edit' && selector.ui}
      {mode === 'edit' && uploadId && (
        <button
          onClick={() => setDoorAlignOpen(v => !v)}
          className={`absolute top-3 left-3 z-40 px-3 py-1.5 rounded cursor-pointer text-xs font-bold ${
            doorAlignOpen ? 'bg-yellow-500 text-black' : 'bg-indigo-600 hover:bg-indigo-500 text-white'
          }`}
        >
          {doorAlignOpen ? '문 정합 닫기' : '문 정합'}
        </button>
      )}
      {doorAlignOpen && uploadId && (
        <Suspense fallback={null}>
          <DoorAlignModal
            coreRef={coreRef}
            uploadId={uploadId}
            currentUrl={currentUrl}
            onDone={(u) => { setDoorAlignOpen(false); reloadWithUrl(u); }}
            onClose={() => setDoorAlignOpen(false)}
          />
        </Suspense>
      )}
      {mode === 'edit' && (
        <div className="absolute top-3 right-3 bg-black/70 text-gray-300 text-xs rounded p-3 flex flex-col gap-2 select-none min-w-[180px]">
          {/* ── 변환 도구 ── */}
          <div className="text-white font-bold text-sm">변환</div>
          {!transform.active ? (
            <button
              onClick={handleStartTransform}
              className="px-2 py-1 bg-teal-600 hover:bg-teal-500 text-white rounded cursor-pointer"
            >
              선택 → 변환 시작
            </button>
          ) : (
            <div className="flex flex-col gap-1">
              <div className="flex gap-1">
                <button
                  onClick={() => transform.setMode('translate')}
                  className={`flex-1 px-2 py-1 rounded cursor-pointer ${transform.mode === 'translate' ? 'bg-teal-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}`}
                >
                  이동
                </button>
                <button
                  onClick={() => transform.setMode('rotate')}
                  className={`flex-1 px-2 py-1 rounded cursor-pointer ${transform.mode === 'rotate' ? 'bg-teal-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}`}
                >
                  회전
                </button>
              </div>
              <p className="text-[10px] text-gray-400">
                {transform.mode === 'translate'
                  ? '축 화살표를 드래그하여 이동'
                  : '축 링을 드래그하여 회전'}
              </p>
              <div className="flex gap-1">
                <button
                  onClick={transform.confirmTransform}
                  className="flex-1 px-2 py-1 bg-green-600 hover:bg-green-500 text-white rounded cursor-pointer"
                >
                  확정
                </button>
                <button
                  onClick={transform.cancelTransform}
                  className="flex-1 px-2 py-1 bg-gray-600 hover:bg-gray-500 text-white rounded cursor-pointer"
                >
                  취소
                </button>
              </div>
            </div>
          )}

          <div className="border-t border-gray-600 my-1" />

          {/* ── 문 애니메이션 ── */}
          <div className="text-white font-bold text-sm">문 애니메이션</div>

          {/* 1. 문 지정 */}
          <button
            onClick={handleSetDoor}
            className="px-2 py-1 bg-purple-600 hover:bg-purple-500 text-white rounded cursor-pointer"
          >
            선택 → 문 지정 ({doorIndices ? `${doorIndices.length}개` : '없음'})
          </button>

          {/* 2. 경첩(피벗) 지정 */}
          {doorIndices && !pivotEditor.editing && (
            <button
              onClick={handlePivotEdit}
              className="px-2 py-1 bg-yellow-600 hover:bg-yellow-500 text-white rounded cursor-pointer"
            >
              {pivotEditor.confirmed ? '경첩 재지정' : '경첩 지정'}
            </button>
          )}
          {pivotEditor.editing && (
            <div className="flex flex-col gap-1">
              <p className="text-[10px] text-gray-400">
                끝점: 개별 이동 | 중앙: 평행이동
                <br />
                Shift+드래그 또는 링: 회전
              </p>
              <div className="flex gap-1">
                <button
                  onClick={pivotEditor.confirmAxis}
                  className="flex-1 px-2 py-1 bg-green-600 hover:bg-green-500 text-white rounded cursor-pointer"
                >
                  확정
                </button>
                <button
                  onClick={pivotEditor.stopEditing}
                  className="flex-1 px-2 py-1 bg-gray-600 hover:bg-gray-500 text-white rounded cursor-pointer"
                >
                  취소
                </button>
              </div>
            </div>
          )}

          {/* 3. 열기/닫기 */}
          {doorIndices && pivotEditor.confirmed && !pivotEditor.editing && (
            <div className="flex gap-1">
              <button
                onClick={handleOpen}
                className="flex-1 px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded cursor-pointer"
              >
                열기
              </button>
              <button
                onClick={handleClose}
                className="flex-1 px-2 py-1 bg-orange-600 hover:bg-orange-500 text-white rounded cursor-pointer"
              >
                닫기
              </button>
            </div>
          )}
        </div>
      )}
    </SplatViewerCore>
  );
}
