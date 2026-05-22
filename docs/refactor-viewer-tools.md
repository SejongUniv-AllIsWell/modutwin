# 감사 #5 — viewer-tools 분해 계획

> 감사 보고서(2026-05-21)의 5번째 우선순위. #1–4 는 커밋 `882064a` 에서 적용. 이 작업은 별도 PR 로 진행.

## 목표

viewer-tools 디렉토리의 두 god-file 을 분해해 다음을 달성한다.

1. **잠재 버그 진단** — `DoorAlignModal.tsx:2203, :2230` 의 `eslint-disable react-hooks/exhaustive-deps` 두 건이 정말 의도된 것인지 확인하고 안전하게 만든다.
2. **단일 파일 LOC 가 3,000 줄을 넘지 않도록 한다.** 한 파일 안에 데이터 페치 + 3D 렌더링 + UI 상태 + DOM 조작이 동시에 있는 패턴을 깨뜨린다.
3. **이미 시작된 분할 패턴을 마저 진행한다** — `tools/refine/` 와 `lib/alignment/` 에 일부 모듈이 이미 추출되어 있음.

## 범위

| 파일 | LOC | 비고 |
|---|---|---|
| `frontend/src/components/viewer/tools/useRefineTool.tsx` | 3,386 | hook 안에서 JSX 까지 렌더하는 god-hook. 3326번 라인에 modal. |
| `frontend/src/components/viewer/tools/DoorAlignModal.tsx` | 3,245 | nested modal (`DoorUnitNamePickerModal` at 3176), WebGL framebuffer readback (922), 두 개의 disable 된 hooks-deps. |
| `frontend/src/components/viewer/UnifiedSplatEditor.tsx` | 1,242 | (선택) 데이터 페치 + 뷰어 + 업로드가 같이 있음. 첫 PR 에선 손대지 말 것. |

총 6,631 LOC. 신중하게 단계 분할.

## 이미 준비된 분할 모듈

- `frontend/src/lib/alignment/` — `corners.ts`, `kabsch.ts`, `mat3.ts`, `plane.ts`, `ransac.ts`, `rectFit.ts`, `apply.ts` 가 이미 존재. door alignment 의 수학 부분을 이쪽으로 더 옮길 수 있다.
- `frontend/src/lib/refine/` — `coordFrames.ts`, `persistence.ts` 가 이미 존재. refine 좌표계와 영속화는 빠져 있음.
- `frontend/src/components/viewer/tools/refine/useRefinePersistence.ts` — refine 영속화 hook 이 이미 분리되어 있음. 같은 패턴을 brush/state 에도 적용 가능.

이 패턴을 따라 진행할 것 — 새 컨벤션을 만들지 말 것.

## ESLint disable 두 건 진단

### `DoorAlignModal.tsx:2200-2204` — 코너/두께/margin 변경 시 즉시 refresh

```tsx
const setDoorInternalShowAsyncRef = useRef(setDoorInternalShowAsync);
useEffect(() => { setDoorInternalShowAsyncRef.current = setDoorInternalShowAsync; }, [setDoorInternalShowAsync]);
useEffect(() => {
  if (!doorInternalShow) return;
  void setDoorInternalShowAsyncRef.current(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [picked, doorThickness, doorRefineActive]);
```

**판정**: 의도된 패턴. ref 갱신 + deps 의도적 축소. 토글 호출과 효과를 분리하기 위해 `doorInternalShow` 를 deps 에서 일부러 뺀다 (`if (!doorInternalShow) return;` 으로 가드함).

**액션**: 코드 위쪽 주석에 이 의도가 이미 적혀 있다 — `// (toggle ON 의 직접 호출과 효과를 분리하기 위해 doorInternalShow 는 deps 에서 제외.)`. **잠재 버그 아님. 그대로 유지하되 분해 시 hook 으로 추출해서 패턴을 명시적으로 만든다 (예: `useAutoRefreshDoorInternal(deps)`).**

### `DoorAlignModal.tsx:2222-2231` — 마운트 시 stale splat 정리

```tsx
useEffect(() => {
  if (basemapMode) return;
  const stale = additional.items.filter(it => it.name === '도어 영역 가우시안' && it.source === 'local');
  for (const it of stale) { ... additional.remove(it.id); }
  // mount-once 효과 — eslint dep array intentionally minimal.
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
```

**판정**: 의도된 mount-once. 다만 **`additional.items` 가 마운트 시점에 stale 한 경우 (예: parent 가 lazy 하게 채우는 경우) 정리를 놓칠 가능성**이 있다. 현재 코드 흐름에서는 모달 마운트 = 항상 fresh state 라 안전하지만, 보장은 코드 밖에 있다.

**액션**: 분해 PR 에서 별도의 `useDoorSplatCleanup(additional, basemapMode)` hook 으로 추출하고 `additionalRef.current.items` 패턴으로 stale 참조를 명시적으로 만든다. 이 자체는 잠재 버그라기보단 *암묵적 가정*. 분해 작업으로 자연스럽게 가시화됨.

## 단계 (Phase) 계획

### Phase 1 — 진단 + 안전망 (위험 낮음, 0.5 일)

- [ ] 위 두 useEffect 의 의도를 분해 PR 의 commit message 에 명시적으로 기록
- [ ] DoorAlignModal 의 framebuffer readback (line ~922) 을 `useDoorAlignGl` hook 으로 추출 — 본문 로직은 그대로 옮기기만
- [ ] `DoorUnitNamePickerModal` (line 3176-3245) 을 형제 파일 `DoorUnitNamePickerModal.tsx` 로 분리

검증: typecheck pass + 수동 회귀 (door align 모드 진입 → 코너 4개 클릭 → 두께 슬라이더 → 추출 → 정합 시작).

### Phase 2 — `lib/alignment/doorRect.ts` 추출 (위험 낮음, 0.5 일)

- [ ] `normalizeDoorRect` (line ~125) 와 코너 상수를 `lib/alignment/doorRect.ts` 로 이동
- [ ] DoorAlignModal 은 import 만 — 본문 변경 없음

### Phase 3 — `useRefineTool` 분해 (위험 중간, 1 일)

- [ ] JSX 부분 (modal 3326+) 을 `<RefineToolUI/>` 컴포넌트 파일로 추출
- [ ] hook 자체는 brush / state / persistence 로 더 나누지 않음 — 우선 *render 분리* 만. 이게 먹히는지 보고 추가 분할 여부 결정
- [ ] 회귀 테스트: refine 패널 진입 → 표면 선택 → "모듈 외부 제거" → floater 검출 → 적용

### Phase 4 — UnifiedSplatEditor 정리 (위험 중간, 별도 PR 권장)

- [ ] 폴링 로직 (2.5s/1.5s, line ~368/371) 을 `useUploadStatusPoll(sceneId)` hook 으로 추출
- [ ] `setTimeout(..., 1400)` 라우팅 race fix (line ~1032) 를 toast lifecycle 과 연결하거나 명시적 wait 으로 교체

## 의도적으로 손대지 않을 항목

- **타입 안전성 (`any` 박멸)** — viewer 내부에서 PlayCanvas refs 가 `any` 인 것은 별도 작업. PlayCanvas `Entity`/`AssetRegistry` 타입을 한꺼번에 도입하면 진단이 어려움. 이번 분해와 분리할 것.
- **toast/alert 마이그레이션** — `UnifiedSplatEditor` 와 `useRefineTool` 내부의 `window.alert` 는 분해 PR 에서 같이 처리한다 (분해되면 컨텍스트 받기가 자연스러움).
- **z-index 토큰화** — viewer 내부 (101, 70, 60 등) 는 모달 스택 의도가 명확해 보임. 디자인 토큰 도입 작업 따로.

## 회귀 위험 체크리스트

분해 PR 머지 전에 다음 시나리오를 손으로 검증해야 한다.

- [ ] door align: basemap 모드 진입 → 4 코너 클릭 → 두께/margin 조정 → 문 추출 → 정합 시작 → 회전 애니메이션 확인
- [ ] door align: module 모드 (이전 세션에서 도어 splat 남아있는 상태) 재진입 → stale splat 자동 정리 동작 확인
- [ ] refine: 표면 선택 → 모듈 외부 제거 → floater 검출 → 적용 → persistence (새로고침 후 복원) 확인
- [ ] refine 모달 z-index — 다른 모달과 겹쳤을 때 우선순위

## 작업 시작 진입점

```bash
# 진단부터 시작 (코드 수정 없이 정확한 의도 파악)
git checkout -b refactor/viewer-tools-decompose
grep -n "eslint-disable" frontend/src/components/viewer/tools/DoorAlignModal.tsx
# → 2203, 2230. 두 useEffect 의 주변 주석을 읽고 commit message 초안 작성.
```

## 참고

- 감사 보고서 원본 평가 — drift 가 viewer-tools / explore / cross-page boilerplate 에 *집중*되어 있지 systemic 하지 않다. `lib/alignment`, `lib/gs`, `lib/ply`, `lib/api.ts` 는 건강한 상태. 이 PR 은 viewer-tools 분해에 집중하고 다른 영역은 건드리지 않는다.
- ESLint disable 두 건은 분석 결과 **잠재 버그가 아니라 의도된 ref/mount-once 패턴**. "fix" 가 아니라 hook 추출로 **가시화** 하는 게 목표.
