# [천장제거] 기능 — 구현 Plan (v2, 피드백 반영판)

미니맵 + 층 대표 이미지 파이프라인의 1차 단계. 정합 완료된 층 뷰어에서 천장 wallMesh + 천장 영역 가우시안을 토글로 제거해 실내 공간을 위에서 내려다볼 수 있게 한다. **다운스트림 (관리자 모드 톱뷰 스냅샷)** 이 이 상태에서 캡처해 층 대표 이미지로 사용한다.

---

## 0. 다운스트림과의 관계

후속 작업: 관리자가 메인 모드에서 정합된 층(베이스맵 ± 모듈, 또는 모듈만)을 위에서 스냅샷 → 층 카드 (`<button class="... h-28 lg:h-32 ...">` 자리) 의 대표 이미지로 영속화.

이 다운스트림이 결정하는 본 plan 의 두 가지 제약:
- **모든 정합된 층** 을 커버해야 함 — 베이스맵 유무와 무관. → Issue 4 (primary-as-module) 필수 포함.
- **토글 상태가 안정적으로 적용**돼 있어야 캡처가 의미 있음 — async race 가 남아 있으면 캡처 직후 천장이 다시 보이는 사고. → Issue 1 (race) 필수 해결.

---

## 1. 코드 구조 파악

### 1-A. 기능을 어디에 붙일지 — 층 뷰어 `FloorCompositeViewer`
정합 완료 상태에서 모든 자산이 보이는 화면: `frontend/src/app/buildings/[name]/floors/[floorNumber]/page.tsx`. 이 화면이 보이는 모듈은 `alignment_transform` 이 이미 있는 것들 (`page.tsx:571`).

### 1-B. 제거 대상 — 두 레이어
1. **천장 wallMesh (구워진 텍스처 quad)**
   - 베이스맵 천장: `wallMesh_ceiling` (`useRefinedMeshLoader.tsx:246` → `wallMesh.ts:273`)
   - 모듈 천장: `wallMesh_module_<moduleId>_ceiling` (`floors/[floorNumber]/page.tsx:340-353`)
   - 토글: `ent.enabled = false`

2. **천장 위 영역의 가우시안 (alpha 마스킹)**
   - Primary splat (베이스맵 또는 모듈): `coreRef.getSplatData()` → `posY`, `colorTexture`, `origColorData`
   - 모듈 overlay splat (`useAdditionalGsplats.add()`): origColorData 가 현재 보존되지 않음 → 확장 필요
   - 패턴: `useGaussianSelector.tsx:51-85` 와 동일 (`colorTexture.lock()` → alpha = 0 → `unlock()`)

### 1-C. ceilingY 출처
`mesh.json` 의 `surfaces[i]` 중 `surfaceId === 'ceiling'` 의 `corners[0][1]`. 베이스맵·모듈 동일 자료구조.

### 1-D. 좌표계 정합
PLY 와 mesh.json corners 모두 **baked frame** (Z-180 미적용). `splat.posY` 도 baked. 비교는 baked frame 안에서 그대로:
```
hide if posY[i] > ceilingY - cutoff
```
`cutoff` 는 5–10cm — `floorplan.ts:80` 의 `cutoffY = mnY + cutoff` 와 같은 의도 (천장 자체 + 근처 노이즈까지 함께 제거). bakeFloorplan 의 cutoff 와 의미를 통일.

### 1-E. 시각/논리 라벨 불일치 (claude.md:76, floorplan.ts:80)
Z-180 entity 회전 때문에 baked +Y (실제 방 천장) 가 world 작은 Y 로 매핑됨. **본 기능은 baked 의미 ("실제 방 천장") 기준** — 사용자 의도 ("위에서 실내 공간을 보고 싶다") 가 그것임. world frame 의 시각적 위치는 카메라가 알아서 처리.

---

## 2. v1 plan 의 결함 (피드백 반영)

| # | 결함 | 해결 |
|---|---|---|
| 1 | 토글 useEffect 만 사용 → async 로 늦게 도착하는 자산 미반영 (`page.tsx:247, 313`, `useRefinedMeshLoader.tsx:87` 모두 비동기) | `applyCeilingState()` 헬퍼 분리 + 3 시점 호출 (토글 / splat.ready / mesh 생성). `ceilingRemovedRef` 로 stale closure 회피 |
| 2 | `app.root.children.forEach` 는 root 1-depth 만 봄. 모듈 천장은 `record.group` 자식으로 재부모화 (`page.tsx:354`) | 재귀 불필요. **베이스맵** 천장은 `useRefinedMeshLoader` 콜백으로 직접 수령, **모듈** 천장은 `record.meshEntities` 에서 `__surfaceId.endsWith('_ceiling')` 필터 |
| 3 | `record.splatLayerIds` 는 메인 모듈 splat (`:269`) + 도어 splat (`:410`) 혼합 배열. 단일 `splatLayerId` 필드로는 의도 표현 부족 | `record.mainSplatLayerId: string \| null` 추가. 마스킹은 이 필드만 대상 (도어 splat 은 천장 아래라 어차피 no-op 이지만 의도 명시) |
| 4 | primary 가 모듈인 케이스 미대응. `page.tsx:484` `defaultUrl = basemap?.url ?? defaultModule?.url`. `FloorCompositeViewer` 는 basemap source_upload_id 만 받음 (`:195`) | `FloorCompositeViewer` 시그니처에 `primarySourceUploadId: string \| null` 도 받음. `useRefinedMeshLoader` 를 primary source 로 호출 (베이스맵이면 베이스맵, 모듈이면 그 모듈) — 자산 로딩 로직은 동일 |

---

## 3. 구현 단계

### 단계 1 — `wallMesh.ts`
`createWallMeshFromPersisted` 안에서 entity 에 `__surfaceId` 부착:
```ts
(ent as any).__surfaceId = data.surfaceId;
```
~2 줄. (`createWallMeshEntity` 의 등록 시점에도 동일 패턴 부착 — 다듬기 단계 천장도 같은 식별자.)

### 단계 2 — `useAdditionalGsplats.ts`: origColorData 보존 + ceiling-mask API
asset.ready 직후 colorTexture snapshot 을 `origColorMapRef.current.set(id, snapshot)` 에 저장.

추가 메서드:
```ts
applyCeilingMask(
  id: string,
  ceilingY: number,
  cutoff: number,
  mode: 'remove' | 'restore',
): void
```
내부:
- `assetMapRef.current.get(id)?.resource` 에서 `gsplatData.getProp('y')` (Float32Array) + `streams.textures.get('splatColor')` 추출
- snapshot 이 없으면 (해당 id 의 ready 가 아직 안 됨) 조용히 return — 다음 ready 콜백에서 다시 호출됨
- mode='remove': alpha=0 for `posY > ceilingY - cutoff`, 나머지는 origColor 의 alpha 복원
- mode='restore': 모두 origColor alpha 복원

~50 줄.

### 단계 3 — `useRefinedMeshLoader.tsx`: 콜백 노출
새 옵션:
```ts
onLoaded?: (info: {
  surfaces: Array<{ surfaceId: string; entity: any; corners: number[][] }>;
}) => void
```
mesh.json fetch + 모든 surface entity 생성 후 1회 호출. 호출자가 `surfaceId === 'ceiling'` 의 entity 와 corners (= ceilingY 추출용) 를 받음.

이 콜백은 베이스맵·primary 모듈 양쪽에서 사용 — hook 자체는 source_upload_id 만 다르고 동작 동일.

~15 줄.

### 단계 4 — `FloorCompositeViewer` 시그니처/상태 확장

```tsx
interface Props {
  primaryUrl: string;
  primarySourceUploadId: string | null;   // ★ NEW — 베이스맵 ID 또는 primary 모듈의 source_upload_id
  primaryIsModule: boolean;               // ★ NEW — 마스킹 대상 좌표계 식별용
  moduleOverlays: FloorDetailModuleEntry[];
  ceilingRemoved: boolean;                // ★ NEW — 부모(FloorPage) 가 제어
}
```
상위 `FloorPage` 에서 `primaryIsModule = !manifest?.basemap?.url`, `primarySourceUploadId = manifest?.basemap?.source_upload_id ?? defaultModule?.source_upload_id ?? null` 형식으로 계산.

`ModuleOverlayRecord` 확장:
```ts
type ModuleOverlayRecord = {
  group: any | null;
  splatLayerIds: string[];                 // 기존 — cleanup 용 (메인 + 도어)
  mainSplatLayerId: string | null;         // ★ NEW — 천장 마스크 대상
  meshEntities: any[];                     // 기존
  ceilingEntity: any | null;               // ★ NEW — 빠른 toggle 용
  ceilingY: number | null;                 // ★ NEW — baked frame
  cancelled: boolean;
};
```

primary 자산용 ref:
```ts
const primaryCeilingRef = useRef<{ entity: any | null; ceilingY: number | null }>({
  entity: null, ceilingY: null,
});
const ceilingRemovedRef = useRef(false);  // stale closure 회피
useEffect(() => { ceilingRemovedRef.current = ceilingRemoved; }, [ceilingRemoved]);
```

### 단계 5 — 핵심 헬퍼 `applyCeilingState`

```ts
function applyCeilingState(args: {
  scope: 'all' | { kind: 'module'; record: ModuleOverlayRecord } | { kind: 'primary' };
}) {
  const removed = ceilingRemovedRef.current;
  const cutoff = 0.05;  // 5cm — bakeFloorplan 과 동일 의도

  // (a) primary 천장 mesh
  if (args.scope === 'all' || args.scope.kind === 'primary') {
    const e = primaryCeilingRef.current.entity;
    if (e) e.enabled = !removed;
  }

  // (b) primary 가우시안
  if (args.scope === 'all' || args.scope.kind === 'primary') {
    const sd = coreRef.current?.getSplatData();
    const ceilingY = primaryCeilingRef.current.ceilingY;
    if (sd && ceilingY != null) {
      applyAlphaMaskToSplatData(sd, ceilingY, cutoff, removed);
    }
  }

  // (c) 모듈별
  const records: ModuleOverlayRecord[] =
    args.scope === 'all'
      ? Array.from(overlayRecordsRef.current.values())
      : args.scope.kind === 'module' ? [args.scope.record] : [];
  for (const record of records) {
    if (record.ceilingEntity) record.ceilingEntity.enabled = !removed;
    if (record.mainSplatLayerId && record.ceilingY != null) {
      additional.applyCeilingMask(
        record.mainSplatLayerId, record.ceilingY, cutoff,
        removed ? 'remove' : 'restore',
      );
    }
  }
}
```

`applyAlphaMaskToSplatData`:
```ts
function applyAlphaMaskToSplatData(
  sd: SplatData, ceilingY: number, cutoff: number, hide: boolean,
) {
  if (!sd.colorTexture || !sd.origColorData || !sd.posY) return;
  const data = sd.colorTexture.lock(); if (!data) return;
  const f2h = coreRef.current!.float2Half;
  const zeroH = f2h(0);
  const threshold = ceilingY - cutoff;
  for (let i = 0; i < sd.numSplats; i++) {
    const aboveCeiling = sd.posY[i] > threshold;
    data[i*4+3] = (hide && aboveCeiling) ? zeroH : sd.origColorData[i*4+3];
  }
  sd.colorTexture.unlock();
}
```

### 단계 6 — 호출 시점 3 곳

```ts
// (i) 토글 변경 — 전체 자산 재적용
useEffect(() => { applyCeilingState({ scope: 'all' }); }, [ceilingRemoved]);

// (ii) primary 자산 ready 직후
useRefinedMeshLoader(coreRef, primarySourceUploadId, !!primarySourceUploadId, additional, null, false, /* onLoaded */ ({ surfaces }) => {
  const ceiling = surfaces.find(s => s.surfaceId === 'ceiling');
  if (ceiling) {
    primaryCeilingRef.current = {
      entity: ceiling.entity,
      ceilingY: ceiling.corners[0][1],
    };
  }
  applyCeilingState({ scope: 'primary' });
});

// (iii) 모듈 자산 ready 직후
splat.ready.then(() => {
  // ... 기존 코드 ...
  record.mainSplatLayerId = splat.id;
  applyCeilingState({ scope: { kind: 'module', record } });
});

// mesh 측 (별도 fetch 안에서)
for (let i = 0; i < surfaces.length; i++) {
  const ent = createWallMeshFromPersisted(...);
  record.meshEntities.push(ent);
  if (surfaces[i].surfaceId === 'ceiling') {
    record.ceilingEntity = ent;
    record.ceilingY = surfaces[i].corners[0][1];
    applyCeilingState({ scope: { kind: 'module', record } });
  }
}
```

3 시점 모두에서 `ceilingRemovedRef.current` 를 보므로 토글이 뒤늦게 도착한 자산도 자동 정합.

### 단계 7 — `FloorPage` 에서 상태 + 버튼

```tsx
const [ceilingRemoved, setCeilingRemoved] = useState(false);
// primary source_upload_id 계산
const primarySourceUploadId =
  manifest?.basemap?.url
    ? manifest?.basemap?.source_upload_id ?? null
    : renderableModules.find(m => m.url === primaryUrl)?.source_upload_id ?? null;
const primaryIsModule = !manifest?.basemap?.url;
```

뷰어 컨테이너 우상단:
```tsx
<button
  className="absolute top-4 right-4 z-10 px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm font-bold"
  onClick={() => setCeilingRemoved(v => !v)}
>
  {ceilingRemoved ? '천장 복원' : '천장 제거'}
</button>
```

`FloorCompositeViewer` 에 4 개 prop 전달.

---

## 4. 작업 순서

1. `wallMesh.ts` — `__surfaceId` 부착 (3 줄)
2. `useAdditionalGsplats.ts` — origColor snapshot + `applyCeilingMask` (~50 줄)
3. `useRefinedMeshLoader.tsx` — `onLoaded` 콜백 (~15 줄)
4. `FloorPage` — `primarySourceUploadId` 계산 + ceilingRemoved state + 버튼 (~20 줄)
5. `FloorCompositeViewer` — props 4 개 추가, record 필드 3 개 추가, `applyCeilingState` 및 호출 3 곳 (~80 줄)
6. 수동 검증 매트릭스 — primary=베이스맵 / primary=모듈 × 모듈 overlay 0~N 개 × 토글 전·후 자산 도착 순서

**총 변경량 ~170 줄, 리스크 lowish ~ medium 사이.**

---

## 5. 검증 시나리오 (스냅샷 다운스트림 위해 명시)

1. 베이스맵 + 모듈 3 개 정합 완료 상태에서 즉시 토글 → 베이스맵 천장 + 모든 모듈 천장 동시 제거
2. 페이지 로드 직후 (모든 자산이 들어오기 전) 토글 → 늦게 도착하는 모듈도 자동 마스크 적용
3. 토글 ON 상태에서 새 모듈 자산이 도착 → 그 모듈만 즉시 마스크
4. 토글 OFF 로 복원 → 모든 자산의 alpha 가 origColor 와 동일
5. 베이스맵 없는 모듈-only 층에서 토글 → primary 모듈의 천장만 제거 (overlay 없음)
6. 베이스맵+모듈 층에서 정합 안 된 모듈 (overlay 아님) → 영향 없음

---

## 6. 다운스트림 (Out of MVP)

후속 작업으로 별도 plan 필요. 본 plan 에서는 인터페이스만 보장:

- 톱뷰 카메라 프리셋 (world Y 큰 쪽에서 작은 쪽 — `floorplan.ts:80` 의 mnY 방향) 으로 이동
- `ceilingRemoved=true` 상태에서 캔버스 캡처 (`coreRef.current?.captureFrame?.()` 같은 API 추가 또는 PlayCanvas readPixels)
- 캡처 결과를 층 대표 이미지로 영속화 (`PUT /buildings/{id}/floors/{n}/representative-image` 형태)

본 plan 이 그 캡처 시점에 **천장이 안정적으로 사라져 있음** 을 보장하는 것이 1차 책임. 단계 6 의 시점 3 곳 호출이 그 보장의 핵심.

---

## 7. 위험 요소 / 주의점

1. **`origColorData` snapshot 의 타이밍** — `useAdditionalGsplats` 가 asset.ready 직후 snapshot 을 떠 두어야 함. ready 보다 먼저 토글이 들어오면 snapshot 부재 → mask 동작 skip → ready 직후 자동 호출에서 재시도.
2. **alignment_transform 적용 후 좌표계** — `posY` 는 baked frame, `record.ceilingY` 도 baked frame. alignment R 회전이 baked Y 축을 다른 방향으로 보내도 baked frame 내부 비교는 의미 보존 (천장 평면 위 splat → 회전 후에도 "원래 천장 위 splat" 로서 hide 대상).
3. **베이스맵 wallMesh 와 모듈 wallMesh 의 cleanup** — `record.cancelled` 시 `record.ceilingEntity`/`mainSplatLayerId` 도 nullify. `cleanupRecord` (page.tsx:198) 안에서.
4. **다중 모듈 동시 토글 비용** — 모듈당 마스크 루프는 numSplats 이 N 만 만큼. 50만 splat 모듈 5 개면 ~250만 회 alpha 갱신, 그래도 100ms 미만이라 UI 블로킹 무시 가능.
5. **`onLoaded` 콜백의 멱등성** — 페이지 재마운트 / 모듈 추가 시 다시 호출될 수 있음. primaryCeilingRef 덮어쓰기는 safe (마지막 호출이 최신 자산).
