'use client';

import type { TrainingBounds } from './ColmapViewer';

interface Props {
  dataBounds: TrainingBounds;
  bounds: TrainingBounds;
  onChange: (b: TrainingBounds) => void;
  onReset: () => void;
  onStartTraining: () => void;
  trainingDisabled?: boolean;
  trainingLoading?: boolean;
  trainingDisabledReason?: string;
}

function AxisSlider({
  label, color, min, max, valueMin, valueMax,
  onMinChange, onMaxChange,
}: {
  label: string; color: string;
  min: number; max: number;
  valueMin: number; valueMax: number;
  onMinChange: (v: number) => void;
  onMaxChange: (v: number) => void;
}) {
  const step = Math.max((max - min) / 500, 0.001);
  const fmt  = (v: number) => v.toFixed(2);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className={`text-xs font-medium ${color}`}>{label} 축</span>
        <span className="text-xs text-gray-400">{fmt(valueMin)} ~ {fmt(valueMax)}</span>
      </div>
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 w-6">최소</span>
          <input type="range" min={min} max={max} step={step} value={valueMin}
            onChange={e => onMinChange(Math.min(Number(e.target.value), valueMax - step))}
            className="flex-1 h-1 accent-blue-500 cursor-pointer" />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 w-6">최대</span>
          <input type="range" min={min} max={max} step={step} value={valueMax}
            onChange={e => onMaxChange(Math.max(Number(e.target.value), valueMin + step))}
            className="flex-1 h-1 accent-blue-500 cursor-pointer" />
        </div>
      </div>
    </div>
  );
}

export default function BoundsPanel({
  dataBounds, bounds, onChange, onReset,
  onStartTraining, trainingDisabled, trainingLoading, trainingDisabledReason,
}: Props) {
  const set = (key: keyof TrainingBounds) => (v: number) =>
    onChange({ ...bounds, [key]: v });

  return (
    <div className="w-64 bg-gray-900 border-l border-gray-800 flex flex-col shrink-0">
      <div className="px-4 py-3 border-b border-gray-800">
        <span className="text-xs font-semibold text-gray-300">학습 범위 (Bounding Box)</span>
        <p className="text-xs text-gray-500 mt-0.5">파란 박스 안에서만 GS 학습 수행</p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        <AxisSlider label="X" color="text-red-400"
          min={dataBounds.minX} max={dataBounds.maxX}
          valueMin={bounds.minX} valueMax={bounds.maxX}
          onMinChange={set('minX')} onMaxChange={set('maxX')} />
        <AxisSlider label="Y" color="text-green-400"
          min={dataBounds.minY} max={dataBounds.maxY}
          valueMin={bounds.minY} valueMax={bounds.maxY}
          onMinChange={set('minY')} onMaxChange={set('maxY')} />
        <AxisSlider label="Z" color="text-blue-400"
          min={dataBounds.minZ} max={dataBounds.maxZ}
          valueMin={bounds.minZ} valueMax={bounds.maxZ}
          onMinChange={set('minZ')} onMaxChange={set('maxZ')} />
      </div>

      <div className="px-4 py-3 border-t border-gray-800 space-y-2 shrink-0">
        <button onClick={onReset}
          className="w-full px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs rounded transition">
          초기화
        </button>
        <button
          onClick={onStartTraining}
          disabled={trainingDisabled || trainingLoading}
          title={trainingDisabledReason}
          className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed text-white text-xs rounded font-semibold transition flex items-center justify-center gap-2"
        >
          {trainingLoading && (
            <span className="w-3 h-3 border border-white border-t-transparent rounded-full animate-spin" />
          )}
          {trainingLoading ? '학습 요청 중...' : 'GS 학습 시작'}
        </button>
        {trainingDisabledReason && trainingDisabled && (
          <p className="text-xs text-gray-600 text-center">{trainingDisabledReason}</p>
        )}
      </div>
    </div>
  );
}
