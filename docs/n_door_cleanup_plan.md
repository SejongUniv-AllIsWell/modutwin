# N-door 다듬기(cleanup) 동시 표시·편집 계획 (③ extract-all keep-alive)

목표: **문 다듬기 단계에서 검출된 N개 문의 splat 을 동시에 3D 로 표시**하고,
각 문을 **개별적으로 브러시 정리(included / excluded / deleted)** 한 뒤 모두 저장한다.

> 선행: `docs/n_door_editor_plan.md` (F1~F4). 본 문서는 그 위의 다듬기 다중화(③).

## 합의된 진행 방식 — 안전한 증분

- **①** 다듬기 중 모든 문 **윤곽선(선분)** 표시 — ✅ 완료 (doorOutline line strip, app.root 독립 엔티티라 cleanup 가시성 스냅샷에 안 걸림)
- **②** 다듬기 모달에 문 **chip** (기준 문 + 문 N, active 강조) — ✅ 완료 (정보 표시. `onSelectDoor` 연결 시 전환)
- **③** **실제 N개 splat 동시 생존 + 각 문 브러시 + 저장** — 본 문서 (핵심·고위험)

각 하위 단계마다 `tsc` → 프론트 빌드 → 런타임 테스트로 검증한다.
(프론트는 프로덕션 빌드 컨테이너 `3dgs-frontend` — 소스 변경 시 `docker compose build frontend && up -d frontend` 필요)

## 선결 버그 — 다듬기 중 클릭이 정합문을 바꿈

- 증상: 다듬기(브러시) 중 비정합 문을 클릭하면 그 문이 정합 문으로 전환됨.
- 원인: `UnifiedSplatEditor` 의 N-door "클릭 → 정합 문 지정" 핸들러(mouseup → ray-quad → `setAlignmentDoorIdx`)가
  `mode==='door'` 동안 항상 active. 다듬기 중에도 좌클릭을 가로챔.
- 수정(✅ 완료): 핸들러 게이트에 `if (doorCleanupOverlayOpen) return;` 추가
  (`doorCleanupOverlayOpen` 은 DoorAlignModal `onCleanupOpenChange` 로 이미 동기화됨). deps 에도 추가.
- ③ 에서 chip 으로 활성 문을 바꾸는 UX 와 충돌 없음 (canvas 클릭 ≠ chip 클릭).

## 현재 아키텍처 — 철저히 "단일 문" 전용

추출/다듬기 파이프라인은 모두 문 1개를 가정한다. `DoorAlignModal.tsx`:

| 단일-문 ref / 함수 | 역할 |
|---|---|
| `doorSubGsplatIdRef` | 활성 문 splat 의 `additional` 레이어 id (1개) |
| `activeDoorWrapperRef` | 활성 문 wrapper (mesh+splat 부모, Z-180) (1개) |
| `doorCleanupSnapshotRef` | 활성 문 추출 시점 scene/decomp/alphaDeleted 스냅샷 (1개) |
| `doorCleanupStateRef` | 활성 문 가우시안별 included/excluded/deleted Map (1개) |
| `doorCleanupDoorOrigOrderRef` | 활성 문 splat local idx ↔ orig idx 매핑 (1개) |
| `applyDoorRefine()` | **시작 시 항상 이전 추출 revert**(`:1813`) → 단일 활성. 벽 punch + 문 splat 분리 + mesh + wrapper |
| `revertDoorRefine()` | step1 splat 제거 · step2 wrapper destroy · step3 메인 PLY reload · step4 벽텍스처 복원(`:1612` 단일 문 snapshot 통째) |
| `rebuildDoorRefineFromCleanup()` | 단일 문 splat 제거/재추가 + 메인 PLY reload (states 반영) |
| `bakeNonAlignmentDoors()` | 비정합 문 순차 추출(벽 punch 누적) → 각 자산 캡처 → splat teardown |

추가로 단일-문 가정이 퍼져 있는 ref (asset capture / cleanup repaint 까지 결합):
`lastDoorMeshInputRef`, `lastDoorMeshWallSurfaceIdRef`, `doorSubBlobUrlRef`(`:1284`),
`wallTexSnapshotRef`, `wallViewTexSnapshotsRef`(`:1648`),
`doorGsplatOrigColorsRef`, `doorMeshOrigEmissiveRef`(`:1296`), 완료 시 자산 구성(`:3338`).
→ ③ 는 **per-door asset capture 모델**(아래 ③-5 전제)을 별도로 다뤄야 한다.

`DoorCleanupViewerModal.tsx`: `doorSplatEntity`(1개) + `origIndexOrder`(1개) + `statesRef`(1개).
브러시는 단일 splatDataRef 를 순회.

### ★ 핵심 난점 1 — 인덱스 공간 compaction (High)

`applyDoorRefine()` 는 매번 **현재 `sd.gsplatData`** 로 새 scene 을 만들고(`:1819`), 추출 후
**도어 가우시안을 제거한 새 메인 PLY 로 reload(compaction)** 한다(`:2105`).
따라서 문 2 추출 시 scene 은 이미 문 1 이 빠진 **다른 인덱스 공간**이고,
`doorOriginalIndices`/`boundaryIndices`/`states(origIdx)` 가 문 1 과 비교 불가하다.
→ "base scene + 통합 keep mask" 를 **단순히 합칠 수 없다**. 구현 전 결정 필요:

- **결정(채택): no-compaction 모드.** multi-door cleanup 동안 메인 scene 을
  **얼리지 않고(compact/reload 금지)** 단일 **base scene** 에 고정. 모든 문의 가우시안 집합을
  같은 base 인덱스로 계산. 메인 PLY 재구성(도어 제거)·벽 punch 합성은 **마지막 1회 combine** 으로 미룬다.
- (대안) 가우시안마다 reload 를 건너 살아남는 **전역 안정 id** 도입 — 모든 compaction 경로에 id 전파 필요 → 더 침습적. 채택 안 함.

### ★ 핵심 난점 2 — 면 텍스처 punch 누적 (Medium)

문 추출은 splat 뿐 아니라 **wall mesh 텍스처 + CPU bake cache 에도 alpha punch** 를 적용하고
(`:2179`,`:2200`), revert 는 그 snapshot 을 **단일 문 기준 통째 복원**한다(`:1612`).
여러 문 동시 유지 시 한 문 apply/revert 가 **다른 문의 wall hole 을 지우거나 저장 PNG 가 화면과 달라질** 수 있다.
→ "문별 splat rebuild" 와 **별도로 "면(surfaceId)별 punch 누적 상태 재합성"** 규칙이 필요(③-4).

### ★ 핵심 난점 3 — cleanup 가시성 keep-set (Medium)

`doorCleanupOpen` 시 가시성 스냅샷은 `keepRoot = activeDoorWrapperRef.current` **하나만 남기고**
나머지 `splat`/`wallMesh_*`/`add_splat_*` 를 숨긴다(`:1324`).
"동시 표시" 목표면 keep-set 을 **모든 문 wrapper 집합**으로 일반화하는 **뷰 계층 변경**이 ③-3 에 필요
(모달 props 만으로는 부족).

### 임시 우회 (③ 가 대체)

"정합 시 정합 문 mesh 사라짐" 버그는 현재 **완료 시 bake 후 정합 문 재추출**(`DoorAlignModal.tsx:3422`)로 우회.
③ 에서 모든 문 wrapper 가 동시 생존하면 이 우회는 제거한다.

## 좌표/프레임 (불변)

- 검출 코너: raw 프레임. `planes`: A'(raw+pendingRotation). scene: raw.
- door wrapper: splat 과 동일 Z-180. 자식 mesh/splat local = identity.
- 각 문은 자기 `wallSurfaceId` + `normalInward` 보유 (hinge/swing/open 방향 계산용).

## ③ 설계 — per-door 배열화

### 데이터 모델

단일 ref 들을 문별 엔트리 배열로 일반화:

```ts
interface CleanupDoorEntry {
  doorIdx: number;            // allExtractedDoors 원본 index
  isAlign: boolean;
  label: string;             // "기준 문" | "문 N"
  cornersRaw: Vec3[];        // raw 4코너
  wallSurfaceId: string;
  splatId: string;           // additional 레이어 id (생존 유지)
  wrapper: pc.Entity;        // 문별 wrapper (Z-180)
  origIndexOrder: number[];  // splat local idx ↔ orig idx
  snapshot: DoorCleanupSnapshot; // scene/decomp/alphaDeleted
  states: Map<number, DoorCleanupState>;
}
```

상태: `cleanupDoorsRef: CleanupDoorEntry[]`, `activeCleanupDoorIdx`(state).

### 단계 ③-0 — 전역 가우시안 identity / no-compaction 결정 (선결)

- **base scene 고정**: extractAllDoorsForCleanup 진입 시 현재 메인 scene 을 `cleanupBaseSceneRef` 로 1회 캡처.
  모든 문의 decomp/states/origIdx 는 **이 base 인덱스 공간**으로 계산·저장.
- **no-compaction**: multi-door cleanup 동안 메인 splat 의 도어-제거 reload(`:2105`)·면 punch 복원(`:1612`)을
  **per-door 로 실행하지 않음**. 메인 재구성·punch 합성은 ③-4 의 **단일 combine** 으로만 수행.
- **면별 punch 누적 상태**: `cleanupWallPunchRef: Map<surfaceId, AccumulatedPunch>` 도입.
  각 문 추출은 자기 면의 punch 를 이 누적 상태에 추가만 한다(통째 복원 금지).

### 단계 ③-1 — `applyDoorRefine` keep-alive 모드

- 옵션 `keepAlive?: boolean` 추가.
- keepAlive 시: ① 시작부 revert(`:1813`) 가 splat 제거·wrapper destroy 를 건너뜀,
  ② scene 을 **현재 sd 가 아닌 base scene**(③-0) 기준으로 빌드, ③ 추출 후 **메인 reload(`:2105`) 생략**,
  ④ 면 punch 는 `cleanupWallPunchRef` 에 **누적만**(snapshot 통째 복원 금지).
- 단일 ref 에 쓰는 대신 결과(splatId/wrapper/snapshot/origOrder/meshInput/blobUrl/wallSurfaceId)를 **반환** → 호출자가 배열에 push.
- 검증: keepAlive 미사용(단일 문) 경로는 **바이트 동일** 동작 유지.

### 단계 ③-2 — `extractAllDoorsForCleanup()`

- "문 추출" 버튼(N-door)에서 호출. ③-0 base scene 캡처 후 시작.
- 순서: 기준 문 먼저, 이어 비정합 문들. 각각 **base 기준** keep-alive 추출 → splat 레이어 N개 생존, 각 wrapper(Z-180) 유지.
- `cleanupDoorsRef` 구성, `activeCleanupDoorIdx = 기준 문`.
- 추출 종료 후 **combine 1회**(③-4 의 함수): base − (∪ 모든 문 keep) → 메인 reload, `cleanupWallPunchRef` → 면 텍스처 합성.

### 단계 ③-3 — `DoorCleanupViewerModal` 다중화 + 뷰 가시성 keep-set

- props: `doors: {splatEntity, origIndexOrder, label, isAlign}[]`, `activeIdx`, `onSelectDoor`.
- 브러시 대상 = active 문 splat. chip 클릭 → `onSelectDoor` → activeIdx 전환(브러시/색칠 대상 re-point).
- **가시성 keep-set 일반화(`:1324`)**: `keepRoot` 단일 → **모든 문 wrapper 집합**. cleanup 중 N개 wrapper 모두 보이게.
  (모달 props 외 **뷰 계층 변경** 필수)
- 모든 문 splat 별도 레이어 → 동시 표시. active 문만 색칠 오버레이.
- (대안 B) 브러시가 모든 보이는 문 splat 동시 칠 — 추후.
- ② chip 에 `onSelectDoor` 연결로 활성화.

### 단계 ③-4 — per-door rebuild + combine (메인/면 재합성)

- `rebuildDoorCleanup(doorIdx)`: 해당 문 snapshot+states 로 그 문 splat **레이어만** 재생성.
- **메인 combine(전 문 기준 1회)**: `base − (∪ 모든 문 doorOriginal ∪ 각 states deleted)` keep mask 로 메인 reload.
  → 한 문 편집이 다른 문 제거를 보존.
- **면 텍스처 combine**: `cleanupWallPunchRef`(모든 문 punch 누적) 를 base 면 텍스처에 합성 → 화면/저장 PNG 일치.
- 문별 splat 레이어만 교체, 타 문 wrapper/punch 유지.

### 단계 ③-5 — 완료(저장) 통합 + per-door asset capture

- `bakeNonAlignmentDoors` 의 재추출/teardown 제거 → `cleanupDoorsRef` 의 **이미 정리된** 각 문 splat/mesh 로 자산 구성.
- **per-door asset capture 모델**: 단일 `lastDoorMeshInputRef`/`doorSubBlobUrlRef`/`wallTexSnapshotRef`/
  `doorGsplatOrigColorsRef`/`doorMeshOrigEmissiveRef` 를 문별 엔트리(③ 데이터 모델)에 귀속.
- 정합 문은 live wrapper 유지 → align 단계로 그대로 전달 (재추출 우회 `:3422` 제거).
- **doors.json 스키마 결정**: 현행 계약은 `id/corners/hingeEdge/swing/unitName/doorMesh/doorSplat` 만 인지
  (`uploads.py:967`, refined-bundle `refine.py:433` 도 미사용). → **`is_alignment` 신설 금지**,
  기존 **"정합 문 = `door_1`/active 계약"** 유지(스키마 무변경). (정말 필요해지면 별도 스키마 변경 항목으로 승격)

## 리스크 / 체크포인트

- **인덱스 공간(High)**: no-compaction + base scene 고정으로 해소. per-door reload/compact 금지 준수가 핵심.
- **면 punch 누적(Medium)**: `cleanupWallPunchRef` 로 면별 누적, combine 에서 합성. 통째 복원 금지.
- **가시성 keep-set(Medium)**: 모든 문 wrapper keep. 뷰 계층 변경 포함.
- **per-door asset(Medium)**: 단일 asset/repaint ref 를 문별로 귀속.
- **doors.json 스키마(Low)**: `door_1`=정합 계약 유지, `is_alignment` 미신설.
- **단일 문 회귀 금지**: keepAlive 미사용 경로 동일. N==1 은 ③ 미진입.
- **성능/메모리**: 문 N개 splat 레이어 동시 로드.
- **검증**: ③-1 추출 1개 동일 → ③-2 N개 생존 표시(가시성 keep-set) → ③-3 chip 전환 브러시 →
  ③-4 개별 편집 후 타 문 splat/wall hole 보존 + 저장 PNG=화면 → ③-5 저장 후 최종 뷰어 N개 여닫기. 각 단계 빌드+런타임.

## 완료 정의

- 다듬기에서 N개 문 splat 동시 표시.
- chip 으로 문 전환하며 각 문 브러시 정리.
- 저장 시 각 문의 정리 결과가 doors.json/assets 에 반영.
- 최종 뷰어에서 N개 문 모두 정확한 방향으로 여닫힘.
- 단일 문 흐름 무회귀.
