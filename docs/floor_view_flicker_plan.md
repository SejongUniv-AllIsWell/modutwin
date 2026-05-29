# 층 상세 뷰어 깜빡임(flicker) 해결 계획

## 1. 증상

정합 완료된 층의 상세 페이지에 진입한 뒤, 카메라가 **translate(이동)될 때마다 화면이 깜빡인다.**

## 2. 원인 (확정)

깜빡임의 직접 원인은 **translate 동작 자체가 아니라, 같은 공간을 basemap 과 module 이 동시에 중복 렌더링**하고 있기 때문이다. 카메라가 움직이면 겹친 자산들 사이에서 깊이/정렬 충돌이 발생한다.

### 2.1 원인이 아닌 것 (오해 차단)

- **SplatViewerCore 재로드 아님.** 메인 splat 교체 effect 는 `[sogUrl, appReady]` 에만 의존하며 카메라 이동에는 반응하지 않는다. → `SplatViewerCore.tsx:767`
- **React remount / 로딩 overlay 아님.** 로딩 오버레이는 `loading && sogUrl` 조건이며 translate 와 무관하다.
- **뷰 의존 벽 텍스처 로직 아님.** 현재 로컬 데이터 기준 이 층의 refined mesh `textureVariants` 가 전부 0개라, "카메라 위치에 따라 벽 텍스처를 바꾸는" 경로는 애초에 동작하지 않는다.

### 2.2 실제 원인: 중복 렌더

basemap 이 존재하면 진입 즉시 다음이 **동시에** 올라간다.

| 자산 | 코드 위치 |
|---|---|
| basemap 메인 gsplat (primary) | 기본 `primaryUrl = basemap.url` — `page.tsx:572-573` |
| 정합된 module gsplat (overlay) | `page.tsx:657-660` (moduleOverlays), 추가는 `useAdditionalGsplats.ts:159` |
| basemap wall mesh | `useRefinedMeshLoader.tsx:261` |
| module wall mesh | FloorCompositeViewer overlay effect `page.tsx:297~507` |

즉 **같은 방을 basemap 과 module 이 둘 다 그린다.** 이 상태에서 카메라가 translate 되면:

- **겹친 gsplat** 끼리는 정렬(sort) 순서가 시점마다 달라져 **shimmer** 가 생긴다.
- **겹친 wall mesh** 는 `depthWrite=true` 인 불투명 cutout 재질인데 `polygonOffset`/depth bias 가 전혀 없어 **z-fighting** 이 난다.
  - cutout 재질 정의: `wallMesh.ts:41-49` (`applyBakedTextureCutout` — `alphaTest`, `blendType=BLEND_NONE`, `depthWrite=true`)
  - mesh entity 생성: `wallMesh.ts:347` (offset/bias 설정 없음)

### 2.3 현재 room 클릭 동작 (중복이 안 풀리는 이유)

사이드바에서 호수를 클릭해도 basemap 이 있으면 `selectedModuleId` 만 바뀌고 primary 는 basemap 그대로다. overlay 도 그대로 모두 떠 있다.

```
onClick: setSelectedModuleId(module.id);
         if (!hasBasemap) setPrimaryUrl(module.url);   // basemap 있으면 primary 안 바뀜
```
→ `page.tsx:828-831`

## 3. 해결안

### 3.0 wall mesh depth offset (3.A 채택 시 불필요 → 3.B 전용 보강)

wall mesh 에 depth offset 을 넣어 z-fighting 을 막는다.

> **우선순위 재조정 (검토 결과).** 처음에는 "필수 선반영" 으로 잡았으나, **3.A 를 채택하면 기본 뷰에서 두 wall mesh 가 겹치지 않으므로 z-fight 자체가 사라진다.** 즉 3.0 은 깜빡임 해결에는 더 이상 필요 없고, 오직 3.B(동시 합성)에서 겹친 면을 남길 때만 의미가 있다. → **3.A 로 갈 경우 생략, 3.B 로 갈 경우에만 적용.**

**구현 주의 (caller-driven 이어야 함).** depth offset 을 `wallMesh.ts` 전역에 넣으면 안 된다. 재질 셋업 `applyBakedTextureCutout` (`wallMesh.ts:41`) 은 공용 helper 로,
- `createWallMeshEntity` (`wallMesh.ts:185`) → 편집 화면(`DoorAlignModal.tsx:1685`, `useRefineTool.tsx:1071`)
- `createWallMeshFromPersisted` (`wallMesh.ts:311`) → basemap / module-primary 로드 + overlay (`page.tsx:414,473`)

가 모두 거친다. 전역 수정 시 basemap-only 화면·편집 화면까지 offset 이 들어가 **회귀**가 난다. 따라서 caller 에서 `isOverlay`(또는 `depthBias`) 옵션을 넘겨 **겹치는 쪽 mesh 에만** bias 를 주어야 한다.
- 수정 위치: `applyBakedTextureCutout` 시그니처에 옵션 추가(`wallMesh.ts:41`) + 두 생성 helper 가 caller 옵션을 전달(`wallMesh.ts:160,265`)

---

### 3.A 1차 권장안 — 한 번에 하나의 canonical source 만 렌더 (✅ 추천)

깜빡임을 **구조적으로** 없애는 가장 안전한 방법. 중복 자체를 제거한다.

**설계**
- **별도 `viewerMode` state 를 추가하지 않는다.** 모드는 `primaryUrl` 에서 파생한다. 코드베이스는 이미 `primaryIsModule = manifest?.basemap?.url !== primaryUrl` (`page.tsx:670`) 로 모드를 파생하고 있다. → "floor 모드" = `primaryUrl === basemap.url`, "module 모드" = `primaryUrl === module.url`.
- 기본 진입: `primaryUrl=basemap.url` (현재 `page.tsx:572-573` 그대로), **`moduleOverlays=[]`**
- 사이드바 호수 클릭: basemap 위에 얹지 말고 → `primaryUrl=module.url`, `selectedModuleId=module.id` 로 **전환** (즉 basemap 이 있어도 `setPrimaryUrl` 호출)
- 상단에 **[전체 층 보기]** 버튼 추가 → `primaryUrl=basemap.url` 로 복귀

**module 모드에서 basemap refined asset 도 꺼야 함 (검토 결과 추가).**
`moduleOverlays=[]` + `primaryUrl=module` 만으로는 부족하다. basemap refined 로더(`page.tsx:225`)는 `!!basemapSourceUploadId` 만으로 동작하며 `primaryIsModule` 을 보지 않는다(`page.tsx:228`). 그리고 `basemapSourceUploadId = manifest?.basemap?.source_upload_id` (`page.tsx:1032`) 라 primaryUrl 과 무관하게 항상 채워진다. 도어 splat 도 같은 호출의 `additional` 인자로 함께 로드된다(`page.tsx:229`). → **첫 로더의 `enabled`(3번째 인자)를 `!primaryIsModule && !!basemapSourceUploadId` 로 게이트**해야 basemap wall mesh + 도어 splat 부분 중복이 사라진다.
- **teardown 자동 처리:** 이 로더는 `enabled` 가 false 로 바뀌면 effect cleanup 에서 엔티티 destroy + 도어 splat 제거를 이미 수행한다(`useRefinedMeshLoader.tsx:79-99, 383`, deps 에 `enabled` 포함 `:389`). 따라서 모드 전환 시 이미 로드된 basemap 자산도 자동 정리되어 별도 teardown 코드는 불필요.

**효과 / 리스크**
- gsplat 중복 + wall mesh 중복 + basemap 도어 splat 중복이 동시에 사라져 깜빡임이 구조적으로 사라진다.
- 이미 있는 `primaryIsModule` 경로(`page.tsx:670`)와 천장 제거 로직(`useCeilingRemoval`)이 그대로 재사용되므로 변경 리스크가 낮다.
- `viewerMode` 를 파생값으로 두면 `reloadManifest()`(`page.tsx:565`)가 `primaryUrl` 을 재설정하는 순간 모드도 자동 재동기화된다 → module 삭제·재진입·refresh 후 desync 없음(아래 동기화 규칙 참조).
- **트레이드오프:** "층 전체 basemap 위에 정합된 room 들을 동시에 합성" 하는 뷰는 포기한다(전체/개별 토글로 대체).

**동기화 규칙 (검토 결과 명시).**
- mode 는 항상 `primaryUrl` 에서 파생 — 진실의 원천(source of truth)은 `primaryUrl` 하나.
- `reloadManifest()` 는 이미 `primaryUrl`/`selectedModuleId` 를 재설정하므로(`page.tsx:573-574`), 모드를 별도 state 로 두지 않는 한 동기화 코드가 추가로 필요 없다.
- (만약 그래도 별도 state 가 필요하다고 판단되면 → `reloadManifest()` 안에서 viewerMode 까지 함께 재설정할 것. 하지만 파생 방식이 우선.)

**핵심 수정 위치**
- moduleOverlays 계산을 단일 source 로 게이트(basemap 있으면 `[]`): `page.tsx:657-660`
- basemap refined 로더 `enabled` 게이트(`!primaryIsModule`): `page.tsx:225-238`
- room 클릭 핸들러(basemap 있어도 `setPrimaryUrl(module.url)`): `page.tsx:828-831`
- [전체 층 보기] 버튼 + viewer 주입부: `page.tsx:1028-1035`
- 기본 primaryUrl 초기화: `page.tsx:572-574`

---

### 3.B 2차 정석안 — 겹치는 basemap 영역을 잘라 합성 (composite 가 꼭 필요할 때만)

"층 전체 basemap 위에 정합된 room 들을 동시에 보여줘야 한다" 가 요구사항으로 확정되면, 겹치는 **basemap 쪽을 잘라내는** 방식으로 간다.

**설계**
1. `useRefineTool` 의 boundary cull 로직(polygon SD + ceiling/floor plane 계산)을 공용 헬퍼로 분리. 후보: `frontend/src/lib/gs/roomMask.ts`
   - 재사용 대상: `useRefineTool.tsx:531` 부근 boundary cull 계산
2. 각 module 의 `mesh.json` 에서 room volume 복원 (module surface 메타는 이미 읽고 있으므로 기반 데이터 존재)
3. basemap primary splat 에 `applyVolumeMask()` 추가 → "module room 내부" gaussian 을 alpha 0 으로
   - 천장 제거에서 쓴 `colorTexture.lock()` + half-float alpha 패턴 재사용 (`useCeilingRemoval.ts` / `useAdditionalGsplats.ts` 의 마스크 로직 참고)
4. module 은 그대로 보이고, basemap 은 그 room 안에서만 빠지므로 겹침이 사라진다.
5. basemap wall mesh 도 같은 room 경계에 걸리는 면은 숨기거나, 최소 caller-driven depth offset(**3.0**) 부여 — 이 경로에서만 3.0 이 의미를 가진다.

**효과 / 리스크**
- composite 뷰를 유지하면서 중복 제거. 단, volume mask 계산·좌표 변환 정확도에 따라 경계에서 잔상이 남을 수 있어 구현·검증 비용이 1차안보다 크다.

**핵심 재사용/수정 위치**
- boundary cull 계산: `useRefineTool.tsx:531`
- overlay module 로드: `page.tsx:340` 부근
- basemap wall mesh 로드: `useRefinedMeshLoader.tsx:261`

## 4. 권장 진행 순서

1. **3.A 1차 권장안** (primaryUrl 단일 source 전환) — 깜빡임 구조적 해결, 천장 제거 로직 재사용. basemap refined 로더 `enabled` 게이트 + moduleOverlays 단일화 포함.
2. composite 동시 합성이 제품 요구사항으로 확정될 때만 **3.B 2차 정석안** 추진.
3. **3.0 wall mesh depth offset** 은 3.B 를 추진할 때 함께(caller-driven 옵션으로). 3.A 만으로 끝낼 경우 **불필요**.

## 5. 검증 매트릭스

- [ ] basemap 만 있는 층: 진입 후 translate 시 깜빡임 없음
- [ ] basemap + 정합 module 층(현재 깜빡이는 케이스): 진입(floor 모드)에서 translate 깜빡임 없음
- [ ] 호수 클릭 → module 모드 전환 시 단일 source 만 렌더, 깜빡임 없음
- [ ] **module 모드 전환 시 basemap wall mesh + 도어 splat 이 씬에서 사라짐**(부분 중복 제거 확인)
- [ ] **module 모드 → [전체 층 보기] 복귀 시 basemap refined asset 이 다시 로드됨**(teardown/reload 왕복 정상)
- [ ] **module 삭제·floor 재진입·manifest refresh 후 모드와 primaryUrl 불일치 없음**(파생 모드 동기화 확인)
- [ ] 천장 제거 토글이 floor/module 두 모드 모두에서 정상 동작 (기존 기능 회귀 없음)
- [ ] basemap 없이 module 만 있는 층(`primaryIsModule`): 기존 동작 유지
- [ ] (3.0 적용 시) 편집 화면(`DoorAlignModal`/`useRefineTool`)·basemap-only 화면 wall mesh 렌더 회귀 없음

## 6. 결정 필요 사항

- **동시 합성 뷰(basemap + 정합 room 들)가 제품 요구사항인가?**
  - 아니오 → **3.A 만으로 종료** (권장, 3.0 불필요)
  - 예 → 3.A 적용 후 **3.B + 3.0(caller-driven)** 까지 진행

> 참고: 본 문서의 코드 줄 번호는 작성 시점(`dev/jonny`) 기준이며, 리팩터 후 달라질 수 있다.
