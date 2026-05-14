'use client';

import { AdditionalGsplat } from './tools/useAdditionalGsplats';

export interface MainLayerInfo {
  name: string;
  source: 'local' | 'server';
  visible: boolean;
}

interface Props {
  /** 메인(활성) splat (없으면 null — 빈 viewer) */
  main: MainLayerInfo | null;
  onMainToggleVisible: () => void;
  onMainRemove?: () => void;

  additional: AdditionalGsplat[];
  onAdditionalToggleVisible: (id: string) => void;
  onAdditionalRemove: (id: string) => void;
  /** 추가 레이어를 활성(메인) 으로 승격. basemap은 무시. */
  onAdditionalSelect?: (id: string) => void;
}

const sourceBadge: Record<string, { label: string; className: string }> = {
  local:   { label: '로컬',     className: 'bg-gray-700 text-gray-200' },
  server:  { label: '서버',     className: 'bg-blue-700 text-blue-100' },
  basemap: { label: 'BASEMAP',  className: 'bg-purple-700 text-purple-100' },
};

function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
    </svg>
  ) : (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.542-7a9.97 9.97 0 011.563-3.029m5.858.908A3 3 0 1112 9m-3 3a3 3 0 003 3m-7.071 1.071L19.071 4.929" />
    </svg>
  );
}

function LayerRow({
  name, sourceLabel, visible, active, selectable,
  onToggle, onRemove, onSelect,
}: {
  name: string;
  sourceLabel: 'local' | 'server' | 'basemap';
  visible: boolean;
  /** 현재 활성(다듬기/정합 대상) 여부 */
  active: boolean;
  /** 클릭으로 활성화 가능한지 */
  selectable: boolean;
  onToggle: () => void;
  onRemove?: () => void;
  onSelect?: () => void;
}) {
  const badge = sourceBadge[sourceLabel];
  const rowClass = active
    ? 'bg-blue-500/15 border-l-2 border-blue-400'
    : 'border-l-2 border-transparent hover:bg-white/5';
  return (
    <div className={`flex items-center gap-2 px-2 py-1.5 rounded ${rowClass}`}>
      <button
        onClick={onToggle}
        title={visible ? '숨기기' : '보이기'}
        className={`p-1 rounded hover:bg-white/10 cursor-pointer ${visible ? 'text-gray-200' : 'text-gray-500'}`}
      >
        <EyeIcon open={visible} />
      </button>
      <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase ${badge.className}`}>
        {badge.label}
      </span>
      {selectable && onSelect ? (
        <button
          onClick={onSelect}
          title="이 레이어를 다듬기/정합 대상으로 활성화"
          className={`flex-1 text-left text-xs truncate cursor-pointer ${visible ? 'text-gray-200 hover:text-white' : 'text-gray-500 hover:text-gray-300'}`}
        >
          {name}
        </button>
      ) : (
        <span
          className={`flex-1 text-xs truncate ${visible ? 'text-gray-200' : 'text-gray-500'} ${active ? 'font-semibold' : ''}`}
          title={name}
        >
          {name}
        </span>
      )}
      {active && (
        <span className="text-[9px] px-1 py-0.5 rounded bg-blue-500/30 text-blue-200 uppercase tracking-wide">
          활성
        </span>
      )}
      {onRemove && (
        <button
          onClick={onRemove}
          title="제거"
          className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-white/10 cursor-pointer"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}

export default function LayerPanel({
  main,
  onMainToggleVisible,
  onMainRemove,
  additional,
  onAdditionalToggleVisible,
  onAdditionalRemove,
  onAdditionalSelect,
}: Props) {
  const empty = !main && additional.length === 0;

  return (
    <div className="w-72 bg-black/70 backdrop-blur-sm border border-white/10 rounded-lg shadow-lg select-none">
      <div className="px-3 py-2 border-b border-white/10 flex items-center gap-2">
        <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2H7a2 2 0 00-2 2v2m14 0h-5l-2-2H7" />
        </svg>
        <span className="text-xs font-semibold text-gray-200">레이어</span>
        <span className="ml-auto text-[10px] text-gray-500">
          {(main ? 1 : 0) + additional.filter(it => !it.meta?.hiddenInPanel).length}
        </span>
      </div>
      <div className="p-1.5 max-h-[60vh] overflow-y-auto">
        {empty && (
          <p className="text-[11px] text-gray-500 px-2 py-3 text-center">
            아직 레이어가 없습니다.
          </p>
        )}
        {main && (
          <LayerRow
            name={main.name}
            sourceLabel={main.source}
            visible={main.visible}
            active
            selectable={false}
            onToggle={onMainToggleVisible}
            onRemove={onMainRemove}
          />
        )}
        {additional.filter(it => !it.meta?.hiddenInPanel).map(item => {
          const selectable = item.source !== 'basemap' && !!onAdditionalSelect && item.loaded && !item.error;
          return (
            <LayerRow
              key={item.id}
              name={item.error ? `${item.name} (오류)` : item.loaded ? item.name : `${item.name} (로딩 중)`}
              sourceLabel={item.source}
              visible={item.visible}
              active={false}
              selectable={selectable}
              onToggle={() => onAdditionalToggleVisible(item.id)}
              onRemove={() => onAdditionalRemove(item.id)}
              onSelect={selectable ? () => onAdditionalSelect!(item.id) : undefined}
            />
          );
        })}
      </div>
      {onAdditionalSelect && additional.some(it => it.source !== 'basemap') && (
        <div className="px-3 py-1.5 border-t border-white/10 text-[10px] text-gray-500">
          파일 이름을 클릭하면 다듬기/정합 대상이 됩니다.
        </div>
      )}
    </div>
  );
}
