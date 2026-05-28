# Urgent Patch Needed — Cloudflare 100MB 업로드 한도로 인한 모듈 등록 / SAM3 검출 실패

> 대상 리포: `/home/pjhserver/modutwin` (Next.js frontend + FastAPI backend + MinIO + Cloudflare `splat.wiki`)
> 작성 기준: 현재 `dev_pjh` 브랜치, commit-final staging 청크 수정이 적용된 상태.
> 본 문서의 모든 주장은 코드 `file:line` 으로 근거를 단다. 추측 영역은 명시적으로 "불확실"로 표기한다.

---

## 1. 배경 / 근본원인 (Cloudflare 100MB, 어느 요청이 걸리는지)

`splat.wiki` 는 Cloudflare 뒤에 있고, **단일 요청 본문(request body) ~100MB 한도**가 걸려 있다. 100MB 를 초과하는 단일 multipart/fetch 본문은 nginx/백엔드에 도달하기 전에 Cloudflare 가 드롭한다(브라우저에는 pending 또는 413 으로 보임).

핵심: **nginx 는 어디서도 병목이 아니다.** `client_max_body_size 0` 이 전역(`nginx/nginx.conf:12`)과 `/3dgs-platform/` location(`nginx/nginx.conf:158`)에 설정돼 있다. 100MB 천장은 순수하게 Cloudflare 다.

현재 모듈 등록 라이프사이클에서 100MB 를 초과하는 단일 본문이 Cloudflare 를 가로지르는 지점은 **두 곳뿐**이다.

1. **(LIVE / 항상 차단됨)** `POST /uploads/sam3/prepare` — 원본 모듈 PLY 전체(관측값 193MB: `room636_29999.ply`)를 하나의 multipart 본문으로 전송. `frontend/src/components/viewer/UnifiedSplatEditor.tsx:607-613` 에서 `form.append('file', first)` 후 `api.postForm('/uploads/sam3/prepare', form)`. 193MB ≫ 100MB → Cloudflare 가 origin 전에 드롭 → 세션 미생성 → 자동 문 검출 전체가 사망. 이것이 **현재 살아있는 버그**.
2. **(POSSIBLE / 잠재 위험)** `POST /uploads/commit-final` multipart — 132MB refined PLY 는 이미 staging 청크로 빠졌으나, 남은 `texview_*`(개수 무제한) + `door_splat_*`(크기 무제한)가 한 본문에 묶여 있어 벽/뷰 variant 가 많으면 100MB 에 근접/초과 가능(`frontend/src/components/viewer/UnifiedSplatEditor.tsx:1238-1279`).

`api.postForm` 은 청크 없이 FormData 를 단일 `fetch` 본문으로 그대로 보낸다(`frontend/src/lib/api.ts:170-172`, `api.ts:113-121`). FormData 일 때 `buildHeaders` 는 Content-Type 을 세팅하지 않아 브라우저가 `multipart/form-data` 로 전체 파일을 하나의 본문으로 스트림한다(`api.ts:37-41`). 라우팅은 `API_BASE = NEXT_PUBLIC_API_URL || '/api'`(`api.ts:1`) → `splat.wiki`/Cloudflare 경유.

반면 **청크 + presigned PUT** 경로(아래 4·5장)는 각 본문이 `PART_SIZE = 10MB`(`backend/app/services/minio_service.py:10`)라서 Cloudflare-safe 다. presigned PUT 자체는 `MINIO_PUBLIC_ENDPOINT=splat.wiki`(`.env:27`) 이므로 Cloudflare 를 통과하지만, 각 본문이 10MB 라 한도 미만이다.

---

## 2. 현재 업로드 라이프사이클 (단계별 MinIO 쓰기 + Cloudflare 노출)

모듈 등록의 실제 경로(로컬-PLY 흐름, `UnifiedSplatEditor` 로 들어오는 유일한 흐름) 기준. 각 단계 본문 크기·MinIO 쓰기·Cloudflare 노출을 정리한다.

| 단계 | 엔드포인트 / 동작 | MinIO 쓰기 | Cloudflare 본문 | file:line |
|---|---|---|---|---|
| **0. /upload 파일 선택** | `.ply/.splat/.sog` → 업로드 없음. blob URL + sessionStorage 핸드오프 후 `router.push('/viewer')`. (`/uploads/init`+`/complete` 청크 경로는 **`.zip` COLMAP 전용**) | **없음** | 없음 (blob 핸드오프) | `frontend/src/components/upload/MultipartUploader.tsx:145-170`; init/complete 는 `:187-208`; 뷰어 진입 `frontend/src/app/viewer/page.tsx:86,153,158` |
| **1. 에디터 파일 선택 (handlePickFiles)** | 백그라운드로 `POST /uploads/sam3/prepare` 에 **원본 PLY 전체(193MB)를 단일 multipart** 로 전송. 백엔드는 로컬 디스크 `/var/lib/sam3-temp` 에 1MB 청크 스트림, DB 행/MinIO 없음, 30분 TTL | **없음** (백엔드 로컬 디스크만) | **YES — 193MB 단일 본문, 항상 차단** | FE `UnifiedSplatEditor.tsx:603-619`; BE `backend/app/api/module_register.py:58-91` (`:65` "영구 저장 X", `:74` 1MB 청크) |
| **2. 다듬기(refine) 편집** | 전부 클라이언트(GPU/메모리). lazy-bake 모델 | 없음 | 없음 (네트워크 콜 자체 없음) | `frontend/src/components/viewer/tools/useRefineTool.tsx:262-264` |
| **3. 다듬기 완료 → 문설정 전환 (onSwitchToAlign)** | 로컬(uploadId 없음)이면 `requestMetadata('save')` → `POST /uploads/register-local`. **PLACEHOLDER 행만** 생성(`status=completed`, `ply_target=alignment`, 백킹 객체 없는 placeholder key). 0 바이트 업로드. 이후 Sam3PromptModal 오픈 | **없음 — placeholder 행만** | 없음 (작은 JSON) | FE `UnifiedSplatEditor.tsx:511-538`, `ensureUploadForLocal :226-248`; BE `backend/app/api/uploads.py:781-861` (`:789` "원본 파일 자체는 MinIO 에 올라가지 않는다", `:845` placeholder_key, `:851` file_size=client, `:855` status=completed) |
| **4. 문설정 / SAM3 detect (onStartAuto)** | in-flight prepare 대기 후 `POST /uploads/sam3/detect-temp {session_id, prompt, bake_rotation}` (작은 JSON). 백엔드가 temp-disk PLY 를 door-ml `/detect` 로 포워딩, 코너 4점만 반환. 도어 에셋(splat PLY + 텍스처)은 클라이언트에서 bake | **없음** (`:139` "MinIO 안 건드림") | 없음 (작은 JSON) — **단 STEP 1 차단 시 sid=null → 이 단계 사망, 수동 4점 fallback** | FE `UnifiedSplatEditor.tsx:1037-1078` (`:1047-1048` await, `:1050-1053` sid 가드, `:1056-1058` detect-temp); BE `module_register.py:132-184` (`:142,151-152` temp 읽기, `:157-162` door-ml 포워딩, `:177-184` 코너 반환) |
| **5. 문설정 완료 → 정합 진입 (onSetupSaveDone, 모듈)** | 업로드 없음. 메모리에서 alignment 진입 + `GET /basemaps/active` / `GET /basemaps/{id}/doors` (작은 JSON) 로 베이스맵 도어 매칭 | 없음 | 없음 (작은 JSON) | FE `UnifiedSplatEditor.tsx:990-1029`, `fetchBasemapAndMatchDoor :438-495` |
| **6a. 정합 → staging init** | `POST /uploads/staging-multipart-init {filename, file_size, content_type}` (작은 JSON) → staging key + presigned PUT URLs + part_size(10MB) | (init 만, 바이트 없음) | 없음 (작은 JSON) | BE `backend/app/api/uploads.py:94-114` |
| **6b. staging 청크 PUT** | ~132MB refined `final.ply` 를 **10MB 청크 presigned PUT** 로 MinIO `staging/{user.id}/{uuid}.ply` 에 직접 업로드 → `POST /uploads/staging-multipart-complete` | **YES — 청크 multipart presigned PUT** | 각 본문 10MB → **Safe** | FE `UnifiedSplatEditor.tsx:1208-1235`; BE complete `uploads.py:117-138`; `PART_SIZE` `minio_service.py:10` |
| **6c. commit-final** | `POST /uploads/commit-final` **단일 multipart**: `final_ply_staging_key`(문자열) + mesh.json + doors.json + door 텍스처 PNG + door splat PLY + 모든 surface tex_* + texview_* variant. 백엔드는 `minio.copy_object(final_key, staging_key)` 서버사이드 복사 + 작은 에셋 `put_object_bytes` | **YES — final.ply 는 server-side copy_object; 나머지는 put_object_bytes** | **POSSIBLE — texview_* / door_splat_* 무제한** | FE `UnifiedSplatEditor.tsx:1238-1279`; BE `module_register.py:213-518` (`:419` copy_object, `:422-437` put_object_bytes, `:495` staging 삭제) |

**결론:** 원본 모듈 PLY 는 이 흐름에서 **MinIO 에 절대 저장되지 않는다.** register-local 은 placeholder 행만(바이트 0), SAM3 prepare 는 백엔드 로컬 디스크만. MinIO 에 도달하는 PLY 는 **refined final.ply 뿐이며 STEP 6b(staging 청크) → 6c(server-side copy to final)** 에서만 들어간다.

---

## 3. 사용자 이해 검증 (3개 주장)

### 주장 (1) "SAM3 는 다듬기 → 문설정 단계에서 돈다." — **부분 (PARTIAL)**

- **무거운 업로드(prepare)는 문설정이 아니라 파일-선택(다듬기 시작 순간) 에 발생한다.** `handlePickFiles` 안에서 `setMode('refine')`(`UnifiedSplatEditor.tsx:600`) 직후, non-basemap 이면(`:605`) 즉시 백그라운드로 `/uploads/sam3/prepare` 를 쏜다(`:607-613`). 이게 파일 추가 이벤트지 다듬기 액션도, 문설정도 아니다.
- **문설정 → detect-temp 만** 실제 refine→door 전환에서 발생한다. `onSwitchToAlign`(`:511-538`) 으로 `mode='door'` 진입 → Sam3PromptModal → `onStartAuto` → `detect-temp`(`:1056-1058`).
- **정정:** "SAM3 가 다듬기→문설정에서 돈다"는 detect 만 맞고, 진짜로 깨지는 무거운 부분(prepare 193MB 업로드)은 **파일 선택 시점**에 이미 발사된다.

### 주장 (2) "원본 PLY 를 MinIO 에 저장하는 단계는 문설정 이후, 정합 진입 = commit-final 시점이다." — **오류 (WRONG, 원본 PLY 관점)**

- **원본 PLY 는 어느 시점에도 MinIO 에 저장되지 않는다.** register-local 은 placeholder 행만 만든다(`uploads.py:789,845,851,855`). 함수 `781-861` 전체에 MinIO 쓰기 콜이 하나도 없다.
- 문설정/정합 시점의 register-local 도 placeholder 일 뿐이고, MinIO 에 들어가는 PLY 는 **refined final.ply 뿐**(STEP 6b staging → 6c copy).
- **정정:** "commit-final 이 (원본) PLY 를 MinIO 에 저장한다"는 틀렸다. commit-final 이 저장하는 건 **refined final.ply**(server-side copy_object, `module_register.py:419`)이지 원본이 아니다.

### 주장 (3) "정합/commit-final 에서 전부 재업로드되며, 기존 업로드를 재사용하고 신규만 올려야 한다." — **취지는 정확 (CORRECT in spirit), 적용 범위는 제한적**

- commit-final 직전 MinIO 에 이미 존재하는 유일한 것은 **final.ply (staging key)** 뿐이고, 코드는 이미 이걸 재업로드 대신 `copy_object` 로 **재사용**한다(`module_register.py:419`).
- 나머지 작은 에셋(mesh.json/doors.json/tex_*/texview_*/door_tex_*/door_splat_*)은 refine/문설정 단계에서 브라우저 메모리로만 생성돼 **한 번도 persist 된 적 없는 진짜 신규 파일**이다 — 따라서 commit-final 에서 첫-쓰기 되는 게 정상이다.
- **정정:** "전부 재업로드" 는 작은 에셋에 대해선 사실상 첫-쓰기다. 주장 (3) 의 진짜 가치는 (a) **원본 PLY persist 를 상류로 끌어올리는 것**(P0 redesign B)과 (b) **texview_* / door_splat_* 를 staging 채널로 빼서 commit-final multipart 본문을 줄이는 것**(P2)에 있다.

---

## 4. 이미 적용된 수정 (해결된 것 / 남은 것)

**적용된 것 (이번 세션):** commit-final 의 ~132MB refined final.ply 를 commit-final multipart 본문 밖으로 빼냈다.

- 신규 엔드포인트 `POST /uploads/staging-multipart-init` + `POST /uploads/staging-multipart-complete` (`backend/app/api/uploads.py:94-114`, `:117-138`) 로 클라이언트가 `staging/{user.id}/{uuid}.ply` 에 10MB 청크 presigned PUT.
- commit-final 은 Form 필드 `final_ply_staging_key` 를 받아(`module_register.py:221`) staging prefix 검증(`:256-257`) 후 `minio.copy_object(final_ply_key, staging_key)` 서버사이드 복사(`:419`), 이후 staging temp 삭제(`:495`).
- `minio_service.py` 에 `copy_object` 메서드 추가됨.
- 프론트 3-phase: init → 10MB 청크 PUT loop → complete (`UnifiedSplatEditor.tsx:1208-1235`).

**해결된 것:** 132MB refined PLY 가 더 이상 Cloudflare 단일 본문을 타지 않는다. 일반적인 모듈 등록 commit-final 은 100MB 미만으로 안정.

**남은 것:**
- **P0:** SAM3 `prepare` 의 193MB 원본 PLY 단일 multipart 는 **그대로 차단** → 자동 문 검출 여전히 사망.
- **P1:** commit-final 작은 에셋은 여전히 단일 multipart 본문에 묶임(구조적으로 재사용/신규-구분 안 함).
- **P2:** `texview_*`(개수 무제한) + `door_splat_*`(크기 무제한)가 commit-final 본문에 남아 100MB 초과 위험이 구조적으로 제거되지 않음.

---

## 5. 남은 필수 패치 (우선순위)

### P0 — SAM3 prepare 193MB Cloudflare 차단 (LIVE 버그)

문제: `UnifiedSplatEditor.tsx:607-613` 이 원본 PLY 전체를 단일 multipart 로 `/uploads/sam3/prepare` 에 전송 → Cloudflare 드롭 → 세션 미생성 → `sam3PrepareSessionIdRef` null(`:614`) → `detect-temp` 사망(`:1050-1053`).

#### 해결안 A — prepare 를 staging 청크 업로드로 전환 (commit-final 6b 와 동일 패턴)

이미 검증된 청크+presigned PUT 템플릿을 그대로 재사용.

- **프론트:** `UnifiedSplatEditor.tsx:603-619` 의 `api.postForm('/uploads/sam3/prepare', form)` 를, STEP 6b 와 동일한 3-phase 로 교체 — `POST /uploads/staging-multipart-init`(`uploads.py:94-114`) → 10MB 청크 presigned PUT loop(`UnifiedSplatEditor.tsx:1208-1235` 패턴 복사) → `POST /uploads/staging-multipart-complete`(`uploads.py:117-138`). 결과 staging key 를 `sam3PrepareSessionIdRef`(또는 신규 ref)에 저장.
- **백엔드:** `detect-temp`(`module_register.py:132-184`)가 현재는 백엔드 로컬 디스크 temp(`:142,151-152`)에서 PLY 를 읽는다. staging key 를 받으면 **MinIO 에서 서버사이드 다운로드 후 door-ml `/detect` 로 포워딩**하도록 분기 추가(현재 door-ml 포워딩 로직 `:157-162` 재사용). 이는 **신규 코드 경로**(현재 temp-disk path 만 존재).
- **트레이드오프:** 기존 prepare(로컬 디스크 30분 TTL) 메커니즘과 별개로 staging MinIO 객체가 생기므로 **누수 정리 필요**(아래 부가 항목). detect-temp 가 MinIO 다운로드를 추가로 하므로 백엔드↔MinIO 한 hop 추가(단 Cloudflare 무관).

#### 해결안 B — 다듬기 직후 PLY 를 MinIO 에 저장하고 MinIO 키 기반으로 detect

- **프론트:** 파일-선택 시점의 prepare(`:607-613`)를 제거하고, **refine 완료(`onSwitchToAlign`, `:511-538`) 직후** 청크 업로드(staging-init/complete 패턴, `uploads.py:94-138`)로 PLY 를 MinIO 에 한 번 저장. (단 이 흐름의 PLY 는 refined 가 아니라 원본일 수도 있어 — 무엇을 detect 에 보낼지 결정 필요. 자동 문 검출은 보통 원본 좌표계 기준이므로 **원본 PLY** 가 맞다.)
- **백엔드:** `detect-temp` (또는 신규 `detect` 엔드포인트)가 **MinIO 키를 받아 서버사이드 다운로드 → door-ml 포워딩 → 코너 4점만 반환**(door-ml 포워딩 `module_register.py:157-162`, bake rotation `:177-182`, 코너 반환 `:184` 재사용). UX 동일(클라이언트는 코너만 받음).
- **트레이드오프:** detect 타이밍이 파일-선택(백그라운드 선반영) → refine 완료(동기)로 늦어져, 문설정 진입 시 약간의 대기 발생 가능. 대신 P1/P2 와 자연스럽게 통합되고(상류 persist), staging-temp 디스크 메커니즘 제거 가능.

**불확실:** 맵은 자동 문 검출이 원본 좌표계 PLY 를 쓴다고 명시하나(`detect-temp` 가 prepare 의 원본 temp PLY 를 포워딩), refine 후 PLY 좌표/스케일이 door-ml 결과에 영향을 주는지는 맵에 단정 근거가 없다. 해결안 B 채택 시 **원본 PLY 를 저장해 detect 에 보내는 것**을 권장(현재 동작과 일치).

**권장:** 해결안 A (변경면 최소, 검증된 패턴 그대로, detect 분기만 추가). B 는 P1/P2 와 함께 가는 더 큰 리팩터.

### P1 — commit-final 전체 재업로드 → 기존 재사용 + 신규만 업로드

현재 commit-final 은 final.ply 만 `copy_object` 로 재사용하고(`module_register.py:419`), 작은 에셋 전부를 단일 multipart 에 묶어 `put_object_bytes`(`:422-437`). 재사용/신규 구분이 없다.

- **템플릿:** refine 경로의 **per-file presigned PUT** 모델(`backend/app/api/refine.py:55-87`, `minio.get_presigned_simple_upload_url`)이 정확한 청사진. refine 은 각 작은 에셋(tex/mesh.json/texview)을 개별 presigned PUT 로 MinIO 에 직접 올린다(`useRefineTool.tsx:1962-2038`) — multipart 번들 없음.
- **구체 변경점:**
  1. 작은 에셋(`tex_*`, `texview_*`, `door_tex_*`, `door_splat_*`, mesh.json)을 commit-final multipart 에서 빼고, refine 의 `refined-upload-url` 패턴(`refine.py:55-87`)처럼 **per-file presigned PUT** 로 브라우저 → MinIO 직접 업로드.
  2. commit-final 본문은 **이미 업로드된 키 목록(JSON) + doors.json 정도의 작은 메타** 만 받도록 축소(`module_register.py:213-227` 시그니처 변경). 백엔드는 키 검증 + DB 행 생성(Task/SceneOutput, `module_register.py:463`)만.
  3. **재사용 판정:** 재진입/재정합 시 변경되지 않은 에셋은 이미 MinIO 에 있으므로(키 존재 검사 `object_exists`, refine 의 `:250` 패턴) 재업로드 스킵.
- **불확실:** 현재 모듈 흐름의 작은 에셋은 "한 번도 persist 안 된 신규"라 첫-실행에선 재사용 대상이 없다(3장 결론). P1 의 실익은 주로 (a) commit-final 본문 축소(= P2 와 겹침), (b) **재정합/재편집 시** 변경 안 된 에셋 스킵에 있다.

### P2 — 도어 splat PLY / view-dependent 텍스처의 잔여 multipart 100MB 초과 위험

commit-final multipart 의 무제한 기여자 두 개:
- `texview_*` — 개수 무제한(#surfaces × #view-variants), 각각 full-res PNG(`useRefineTool.tsx:1818-1831`, append `UnifiedSplatEditor.tsx:1270-1272`).
- `door_splat_door_1.ply` — 도어 영역 Gaussian PLY, **크기 cap 없음**(`DoorAlignModal.tsx:2909-2922`).

- **해결:** 이 둘을 STEP 6b 와 동일한 **staging-multipart 채널**(`uploads.py:94-138`)로 빼서 청크 업로드 → commit-final 에서 `copy_object` 로 최종 키 이동. 그러면 commit-final 본문은 mesh.json + doors.json + base tex_*(소량) 만 남아 100MB 위험이 **구조적으로 제거**된다.
- P1 의 per-file presigned PUT 로 흡수해도 동일 효과(각 본문이 개별 파일 단위 → 10MB 미만 보장은 안 되나, 단일 거대 번들은 사라짐). 큰 PNG/PLY 는 청크 또는 staging 권장.

### 부가 — staging 누수 정리 + 크기/쿼터 cap

- **누수 정리:** commit-final 은 성공 경로에서 staging temp 를 삭제한다(`module_register.py:495`). 그러나 **실패/중단 경로**(commit-final 미도달, 또는 P0-A 의 prepare-staging 객체가 detect 후 버려지는 경우)에 staging/USERID/UUID 객체가 남는다. lifecycle 정책(예: MinIO bucket lifecycle 로 `staging/` prefix N일 만료) 또는 실패 경로 명시적 `delete` 추가 권장.
- **크기/쿼터 cap:** register-local 의 `file_size` 는 클라이언트가 declare 한 값을 그대로 쓰고(`uploads.py:851`) MinIO stat 검증이 없다 → 193MB 행이 실제 바이트 0 으로 존재 가능. staging 청크 경로는 `/uploads/complete` 처럼 실제 stat 으로 `file_size` 보정하는 검증(`uploads.py:308`)을 거치게 하고, 도어 splat PLY / texview 에 **상한 cap** 을 두어 비정상적으로 큰 본문을 사전 차단.

---

## 6. 권장 구현 순서 + 검증 방법

### 순서

1. **P0 해결안 A 먼저** (변경면 최소, LIVE 버그 즉시 해소):
   - 프론트 `UnifiedSplatEditor.tsx:603-619` 을 staging-multipart 3-phase 로 교체(STEP 6b 패턴 재사용).
   - 백엔드 `module_register.py:132-184` detect-temp 에 "staging key → MinIO 서버사이드 다운로드 → door-ml 포워딩" 분기 추가.
   - 부가: P0-A 가 만든 staging 객체의 detect-후 삭제(또는 lifecycle).
2. **P2** (구조적 100MB 제거): commit-final 의 `texview_*` + `door_splat_*` 를 staging 채널로 이전(`uploads.py:94-138` + `module_register.py:419` copy_object 패턴).
3. **P1** (재사용/신규 구분): refine `refined-upload-url`(`refine.py:55-87`) per-file presigned PUT 모델로 작은 에셋 분리, commit-final 시그니처 축소 + `object_exists` 재사용 판정.
4. **부가 cap/쿼터**: register-local file_size 검증, splat/texview 상한.

> 권장: P0-A → P2 → P1 순. P0-B 를 택할 경우 P0/P1/P2 를 한 리팩터로 묶되, 회귀 위험이 크므로 단계 분리 검증 필수.

### 검증 방법

- **P0 (자동 문 검출):** `splat.wiki` 환경에서 193MB PLY(`room636_29999.ply`)로 모듈 등록 → 파일 선택 후 prepare 의 각 청크 PUT 이 10MB(`minio_service.py:10`)로 나뉘어 200/204 인지 네트워크 탭 확인. 문설정 진입 시 `sam3PrepareSessionIdRef` 가 set 되고(`UnifiedSplatEditor.tsx:614`), `detect-temp` 가 코너 4점을 반환(`module_register.py:184`)하는지 확인. door-ml(DGX `100.105.30.119:8100`) `/detect` 200 확인.
- **Cloudflare 한도:** 어떤 단일 요청 본문도 100MB 를 넘지 않는지 — 특히 prepare 청크(10MB)와 commit-final multipart(P2 후 base tex_* 만) 본문 크기를 브라우저 네트워크 탭에서 측정.
- **MinIO 상태:** prepare-staging 객체가 detect 후(또는 lifecycle) 정리되는지, commit-final 후 staging temp 삭제(`module_register.py:495`)되는지 MinIO 콘솔/`mc ls` 확인.
- **P1 재사용:** 동일 모듈 재정합 시 변경 안 된 에셋이 재업로드되지 않는지(네트워크 탭에서 해당 PUT 부재) 확인.
- **end-to-end:** commit-final 후 `SceneOutput.ply_path == final_ply_key`(`module_register.py:463`)와 final.ply 가 server-side copy(`:419`)로 최종 키에 존재하는지 확인.

> nginx 는 어디서도 한도가 아니다(`nginx.conf:12,158`). 검증 시 413/드롭이 보이면 원인은 항상 Cloudflare 100MB 다.