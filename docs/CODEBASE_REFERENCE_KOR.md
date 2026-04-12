# 3DGS 디지털 트윈 플랫폼 - 코드베이스 레퍼런스

> **목적**: 이 문서는 3DGS 디지털 트윈 플랫폼 개발 작업을 위한 기술 레퍼런스입니다. 전체 아키텍처, 파일 위치, 구현 패턴에 대한 종합적인 정보를 제공합니다.

---

## 목차

1. [아키텍처 개요](#아키텍처-개요)
2. [프론트엔드 구조](#프론트엔드-구조)
3. [백엔드 구조](#백엔드-구조)
4. [워커 및 파이프라인](#워커-및-파이프라인)
5. [핵심 알고리즘](#핵심-알고리즘)
6. [데이터베이스 스키마](#데이터베이스-스키마)
7. [API 레퍼런스](#api-레퍼런스)
8. [데이터 흐름](#데이터-흐름)
9. [MinIO 저장소 구조](#minio-저장소-구조)
10. [인증 흐름](#인증-흐름)
11. [배포](#배포)
12. [개발 명령어](#개발-명령어)

---

## 아키텍처 개요

```
┌─────────────────────────────────────────────────────────────┐
│                       사용자 브라우저                         │
└─────────────────────────┬───────────────────────────────────┘
                          │ HTTPS
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    Nginx (80/443)                           │
│  • 요청 제한 (API: 30/s, Auth: 30/min, MinIO: 100/s)         │
│  • 리버스 프록시, WebSocket 업그레이드                         │
└──────┬──────────────────┬──────────────────┬───────────────┘
       │                  │                  │
       ▼                  ▼                  ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐
│   Frontend   │  │   Backend    │  │  MinIO (presigned)   │
│ Next.js:3000 │  │ FastAPI:8000 │  │       :9000          │
└──────────────┘  └──────┬───────┘  └──────────────────────┘
                         │
         ┌───────────────┼───────────────┐
         │               │               │
         ▼               ▼               ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  PostgreSQL  │ │    Redis     │ │  RabbitMQ    │
│    :5432     │ │    :6379     │ │    :5672     │
└──────────────┘ └──────────────┘ └──────┬───────┘
                                         │
                                         │ (PC_HOST_IP 통한 네트워크 연결)
                                         ▼
                              ┌─────────────────────┐
                              │    GPU 서버         │
                              │   Celery Worker     │
                              │  • training 큐      │
                              │  • alignment 큐     │
                              └─────────────────────┘
```

### 기술 스택 요약

| 컴포넌트     | 기술                                                       | 포트   |
| ------------ | ---------------------------------------------------------- | ------ |
| 프론트엔드   | Next.js 14, React 18, TypeScript, Tailwind, PlayCanvas 2.x | 3000   |
| 백엔드       | FastAPI, SQLAlchemy (비동기), Pydantic                     | 8000   |
| 데이터베이스 | PostgreSQL 16                                              | 5432   |
| 캐시         | Redis 7                                                    | 6379   |
| 메시지 큐    | RabbitMQ 3                                                 | 5672   |
| 스토리지     | MinIO (S3 호환)                                            | 9000   |
| 워커         | Celery (GPU 서버)                                          | N/A    |
| 프록시       | Nginx                                                      | 80/443 |

---

## 프론트엔드 구조

```
frontend/
├── src/
│   ├── app/                          # Next.js App Router
│   │   ├── layout.tsx                # 루트 레이아웃 (AuthProvider, Navbar)
│   │   ├── page.tsx                  # 랜딩 페이지 (/)
│   │   ├── login/
│   │   │   ├── page.tsx              # 로그인 리다이렉트
│   │   │   └── callback/page.tsx     # OAuth 콜백 핸들러
│   │   ├── dashboard/page.tsx        # 사용자 대시보드
│   │   ├── upload/page.tsx           # 파일 업로드 인터페이스
│   │   ├── explore/page.tsx          # 건물/층 탐색
│   │   ├── buildings/[name]/page.tsx # 건물 상세
│   │   ├── door-select/[scene_id]/   # 문 선택 (편집 모드)
│   │   ├── viewer/page.tsx           # 메인 3DGS 뷰어
│   │   └── admin/basemaps/page.tsx   # 관리자 베이스맵 관리
│   │
│   ├── components/
│   │   ├── viewer/
│   │   │   ├── SplatViewerCore.tsx   # PlayCanvas 엔진 래퍼 (~520줄)
│   │   │   │   • 캔버스 관리, 카메라 제어 (fly/orbit 모드)
│   │   │   │   • getSplatData()를 통한 GPU 텍스처 접근
│   │   │   │   • ref로 노출: getApp(), getCamera(), onUpdate()
│   │   │   │
│   │   │   ├── SplatViewer.tsx       # 에디터 UI 래퍼 (~175줄)
│   │   │   │   • 편집 모드 vs 읽기 전용 모드
│   │   │   │   • 도구 통합 (선택기, 변환, 문, 피벗)
│   │   │   │
│   │   │   ├── RefineViewer.tsx      # 정제 뷰어
│   │   │   │   • 평면 기반 벽면 클리핑 UI
│   │   │   │
│   │   │   └── tools/
│   │   │       ├── useGaussianSelector.tsx  # 브러쉬/BBox 선택
│   │   │       ├── useTransformTool.ts      # 이동/회전 기즈모
│   │   │       ├── useDoorAnimation.ts      # 문 열림/닫힘 애니메이션
│   │   │       ├── usePivotEditor.ts        # 힌지 축 편집
│   │   │       ├── useRefineTool.tsx        # 평면 기반 정제
│   │   │       ├── gpuSync.ts               # GPU 텍스처 동기화
│   │   │       └── quatUtils.ts             # 쿼터니언 연산
│   │   │
│   │   ├── map/                      # 카카오맵 연동
│   │   ├── upload/                   # 업로드 컴포넌트
│   │   └── dashboard/                # 대시보드 컴포넌트
│   │
│   ├── lib/
│   │   ├── api.ts                    # API 클라이언트 싱글톤 (~125줄)
│   │   │   • 토큰 관리 (401 시 자동 갱신)
│   │   │   • get<T>(), post<T>(), put<T>() 메서드
│   │   │
│   │   ├── auth.tsx                  # 인증 컨텍스트 (~75줄)
│   │   │   • AuthProvider, useAuth() 훅
│   │   │   • Google OAuth 로그인/로그아웃
│   │   │
│   │   └── ws.ts                     # WebSocket 클라이언트
│   │       • 실시간 진행률, task_complete, task_failed
│   │
│   └── types/
│       └── index.ts                  # TypeScript 인터페이스
│           • User, Building, Floor, Module
│           • Upload, Task, Scene, WsMessage
│
├── package.json                      # 의존성
├── tsconfig.json                     # TypeScript 설정
├── tailwind.config.js                # Tailwind 설정 (다크 테마)
└── next.config.js                    # Next.js 설정
```

### 주요 프론트엔드 패턴

**뷰어 모드 선택** (`/viewer?mode=...`)

```typescript
// viewer/page.tsx
const mode = searchParams.get('mode');
if (mode === 'refine') return <RefineViewer />;
return <SplatViewer mode={mode === 'align' ? 'edit' : 'readonly'} />;
```

**SplatViewerCore Ref 인터페이스**

```typescript
interface SplatViewerCoreRef {
  getApp(): pc.Application;
  getCamera(): pc.Entity;
  getCanvas(): HTMLCanvasElement;
  getSplatData(): GaussianSplatData; // GPU 텍스처 접근
  onUpdate(callback: (dt: number) => void): () => void;
  drawLine(start: pc.Vec3, end: pc.Vec3, color: pc.Color): void;
  float2Half(f: number): number;
  half2Float(h: number): number;
}
```

**API 클라이언트 사용법**

```typescript
import { apiClient } from "@/lib/api";

// 인증 토큰 자동 처리
const tasks = await apiClient.get<Task[]>("/tasks");
const result = await apiClient.post<Upload>("/uploads/complete", data);
```

---

## 백엔드 구조

```
backend/
├── app/
│   ├── main.py                       # FastAPI 앱 초기화
│   │   • Lifespan: MinIO 버킷 초기화
│   │   • CORS, 미들웨어, 라우터
│   │
│   ├── core/
│   │   ├── config.py                 # 설정 (Pydantic)
│   │   │   • Database, Redis, RabbitMQ, MinIO, JWT, Google OAuth
│   │   │
│   │   ├── database.py               # 비동기 SQLAlchemy 설정
│   │   │   • Engine: pool_size=20, max_overflow=10
│   │   │   • async_sessionmaker, DeclarativeBase
│   │   │
│   │   └── security.py               # JWT, 비밀번호, 인증 의존성
│   │
│   ├── api/
│   │   ├── auth.py                   # 인증 (~316줄)
│   │   │   • POST /auth/login        → Google OAuth URL
│   │   │   • GET  /auth/callback     → OAuth 콜백
│   │   │   • POST /auth/exchange     → 인증 코드 → 토큰
│   │   │   • POST /auth/refresh      → 토큰 갱신
│   │   │   • POST /auth/logout       → 토큰 폐기
│   │   │   • GET  /auth/me           → 현재 사용자 정보
│   │   │
│   │   ├── uploads.py                # 파일 업로드 (~298줄)
│   │   │   • POST /uploads/init      → 멀티파트 초기화, presigned URL
│   │   │   • POST /uploads/complete  → 완료, 학습 태스크 트리거
│   │   │   • GET  /uploads           → 업로드 목록
│   │   │   • GET  /uploads/{id}      → 업로드 상세
│   │   │   • GET  /uploads/{id}/presigned-url → 다운로드 URL
│   │   │
│   │   ├── tasks.py                  # 태스크 관리 (~108줄)
│   │   │   • GET /tasks              → 태스크 목록
│   │   │   • GET /tasks/{id}         → 태스크 상세
│   │   │   • GET /tasks/{id}/progress → 실시간 진행률 (Redis)
│   │   │
│   │   ├── scenes.py                 # 씬 출력 (~183줄)
│   │   │   • GET  /scenes            → 정합된 씬 목록
│   │   │   • GET  /scenes/{id}       → 씬 상세
│   │   │   • GET  /scenes/{id}/download → Presigned SOG URL
│   │   │   • POST /scenes/{id}/door-position → 문 저장, 정합
│   │   │
│   │   ├── basemaps.py               # 관리자 베이스맵 (~193줄)
│   │   │   • GET  /admin/basemaps    → 베이스맵 목록
│   │   │   • POST /admin/basemaps/upload → 후보 생성
│   │   │   • PUT  /admin/basemaps/{id}/approve
│   │   │   • PUT  /admin/basemaps/{id}/reject
│   │   │   • PUT  /admin/basemaps/{id}/activate
│   │   │
│   │   ├── buildings.py              # 건물/층/모듈 CRUD
│   │   ├── notifications.py          # 사용자 알림
│   │   ├── refine.py                 # 정제 엔드포인트
│   │   └── ws.py                     # WebSocket 핸들러
│   │
│   ├── models/
│   │   └── __init__.py               # SQLAlchemy ORM 모델
│   │       • User, Session, AccessLog
│   │       • Building, Floor, Module
│   │       • Upload, Task, SceneOutput
│   │       • Basemap, Notification
│   │
│   ├── schemas/                      # Pydantic 스키마
│   │   └── (요청/응답 모델)
│   │
│   ├── services/
│   │   ├── minio_service.py          # MinIO 작업 (~123줄)
│   │   │   • ensure_bucket(), init_multipart_upload()
│   │   │   • get_presigned_upload_urls(), complete_multipart_upload()
│   │   │   • get_presigned_download_url(), upload_from_file()
│   │   │
│   │   ├── celery_service.py         # 태스크 디스패치 (~63줄)
│   │   │   • dispatch_training_task()
│   │   │   • dispatch_alignment_task()
│   │   │
│   │   ├── auth_code_service.py      # Redis 인증 코드
│   │   └── notification_service.py   # WS + DB 알림
│   │
│   └── middleware/
│       └── access_log.py             # 요청 로깅
│
└── alembic/
    ├── env.py                        # 마이그레이션 설정
    └── versions/
        ├── 82d4dfe40750_initial.py   # 초기 스키마
        └── 0001_add_building_*.py    # 건물 계층구조
```

### 주요 백엔드 패턴

**의존성 주입**

```python
from app.core.database import get_db
from app.core.security import get_current_user

@router.get("/tasks")
async def list_tasks(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user)
):
    ...
```

**업로드 쿼터 검증**

```python
# uploads.py - init 엔드포인트
MAX_UPLOADS = 100
MAX_TOTAL_SIZE = 200 * 1024 * 1024 * 1024  # 200GB

# 새 업로드 허용 전 검증
```

**태스크 디스패치 패턴**

```python
from app.services.celery_service import dispatch_training_task

celery_task_id = dispatch_training_task(
    upload_id=upload.id,
    user_id=user.id,
    minio_input_key=upload.minio_path,
    building_id=building_id,
    floor_id=floor_id,
    module_id=module_id,
    module_name=module.name,
    ply_target=upload.ply_target
)
```

---

## 워커 및 파이프라인

```
worker/
├── celery_app.py                     # Celery 설정
│   • Broker: RabbitMQ
│   • Backend: Redis
│   • 큐: training, alignment
│   • prefetch_multiplier=1, task_acks_late=True
│
├── tasks/
│   ├── training.py                   # 3DGS 학습 태스크
│   │   • Task: tasks.training.run_3dgs_training
│   │   • 입력: upload_id, minio_input_key, building/floor/module
│   │   • 흐름: 다운로드 → 검증 → 파이프라인 → 업로드
│   │
│   └── alignment.py                  # 문 정합 태스크
│       • Task: tasks.alignment.run_door_alignment
│       • 입력: ply_key, door_position_key, basemap_key
│       • 흐름: 다운로드 → 정합 → 변환 → 업로드
│
├── pipeline/
│   ├── base.py                       # PipelineModule 추상 클래스
│   │   class PipelineModule(ABC):
│   │       @property
│   │       def name(self) -> str: ...
│   │       def run(self, input_path: str) -> str: ...
│   │       def validate_input(self, input_path: str) -> bool: ...
│   │       def cleanup(self, path: str): ...
│   │
│   ├── runner.py                     # 파이프라인 오케스트레이터
│   ├── sog_converter.py              # PLY → SOG 변환
│   ├── ffmpeg_module.py              # 비디오 → 프레임
│   ├── blur_detection.py             # 프레임 품질 필터
│   ├── colmap_module.py              # Structure from Motion
│   └── gsplat_module.py              # Gaussian Splatting 학습
│
├── minio_helper.py                   # MinIO 다운로드/업로드
│   • download_file(minio_key, local_path)
│   • upload_file(local_path, minio_key)
│
└── redis_helper.py                   # 진행률 추적
    • update_progress(task_id, percent, module_name)
    • clear_progress(task_id)
```

### 파이프라인 모듈 계약

```python
class MyModule(PipelineModule):
    @property
    def name(self) -> str:
        return "my_module"

    def run(self, input_path: str) -> str:
        """
        입력을 처리하고 출력 경로를 반환.
        모듈 간 통신을 위해 디렉토리 경로여야 함.
        """
        output_path = self._process(input_path)
        return output_path

    def validate_input(self, input_path: str) -> bool:
        """입력이 유효하면 True 반환."""
        return os.path.exists(input_path)
```

### 학습 파이프라인 흐름

```
비디오/이미지
    │
    ▼
┌──────────────┐
│   FFmpeg     │  프레임 추출 (2 FPS)
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ BlurDetect   │  흐린 프레임 필터링
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   COLMAP     │  Structure from Motion (cameras.bin, points3D.bin)
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   Gsplat     │  3D Gaussian 모델 학습 → PLY
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ SOGConverter │  PLY → SOG 변환 (웹 포맷)
└──────────────┘
```

---

## 핵심 알고리즘

```
core/
├── door_alignment/                   # RANSAC + SVD 정합
│   └── align.py
│       • _extract_principal_axes(points) → (centroid, ax0, ax1, ax2)
│       • _ransac_plane(points) → (normal, inliers_mask)
│       • build_door_frame(points) → (F[4x4], v_range)
│       • matrix_module2basemap(pts_mod, pts_base) → T[4x4]
│       • apply_transform(T, points) → transformed_points
│
├── refine_module/                    # 평면 기반 클리핑
│   ├── clip.py
│   │   • determine_outside(xyz, normal, d) → (mask, dist)
│   │   • clip_single_plane(ply, normal, d, out, thickness) → n_removed
│   │
│   └── flat_opaque.py               # 벽면 부착
│
├── select_gaussians/                 # 가우시안 선택
│   ├── manual.py                    # 브러쉬/BBox 도구
│   └── auto.py                      # SAM3 기반 자동 선택
│       • 5단계 파이프라인:
│       • 1. 모델 로드 (PLY/PT)
│       • 2. 이미지에서 SAM3 세그멘테이션
│       • 3. 기여 가우시안 추출
│       • 4. 집계 + DBSCAN 필터
│       • 5. PLY + 메타데이터 내보내기
│
└── grouping/                         # 시맨틱 그룹핑
    └── module.py
```

### 문 정합 알고리즘

```
입력: module_door_points, basemap_door_points

1. RANSAC 평면 피팅
   • 이상치 제거 (손잡이, 모서리)
   • 로버스트 평면 법선 추정

2. 로컬 프레임 구축 (각 문에 대해)
   • SVD → 주축
   • 법선을 외부 방향으로 정렬 (밀도 휴리스틱)
   • 수직 축을 위로 정렬
   • F = [u | v | n | centroid]

3. 스케일 계산
   • s = v_range_basemap / v_range_module

4. 변환 행렬 계산
   • T = F_basemap @ Scale @ F_module⁻¹

출력: 4x4 동차 변환 행렬
```

---

## 데이터베이스 스키마

### 엔티티 관계도

```
┌─────────┐     ┌─────────┐     ┌─────────┐
│  User   │────<│ Session │     │AccessLog│
└────┬────┘     └─────────┘     └─────────┘
     │
     │1:N
     ▼
┌─────────┐
│ Upload  │─────────────────────────┐
└────┬────┘                         │
     │1:N                           │N:1
     ▼                              ▼
┌─────────┐     ┌─────────┐     ┌────────┐
│  Task   │────>│SceneOut │────>│ Module │
└─────────┘     └─────────┘     └───┬────┘
                                    │N:1
                                    ▼
┌─────────┐     ┌─────────┐     ┌────────┐
│ Basemap │────>│  Floor  │<────│Building│
└─────────┘     └─────────┘     └────────┘
                    │
                    │1:N
                    ▼
              ┌────────────┐
              │Notification│
              └────────────┘
```

### 테이블 상세

| 테이블            | 주요 컬럼                                               | 비고            |
| ----------------- | ------------------------------------------------------- | --------------- |
| **users**         | id (UUID), google_id, email, role (user/admin)          | Google OAuth    |
| **sessions**      | user_id, refresh_token_hash, expires_at                 | JWT 갱신        |
| **access_logs**   | ip, endpoint, method, status_code, timestamp            | 감사 추적       |
| **buildings**     | id (UUID), name (unique)                                | 최상위 컨테이너 |
| **floors**        | building_id, floor_number                               | 건물당 고유     |
| **modules**       | floor_id, name                                          | 층당 고유       |
| **uploads**       | user_id, module_id, minio_path, ply_target, status      | 파일 추적       |
| **tasks**         | upload_id, celery_task_id, task_type, status, progress  | 작업 추적       |
| **scene_outputs** | task_id, module_id, ply_path, sog_path, is_aligned      | 결과물          |
| **basemaps**      | floor_id, version, status (pending/approved), is_active | 층 베이스맵     |
| **notifications** | user_id, message, type, is_read                         | 사용자 알림     |

### Enum 정의

```python
class UserRole(enum.Enum):
    user = "user"
    admin = "admin"

class UploadStatus(enum.Enum):
    uploaded = "uploaded"
    processing = "processing"
    completed = "completed"
    failed = "failed"

class TaskType(enum.Enum):
    training_3dgs = "3dgs_training"
    door_alignment = "door_alignment"
    basemap_realign = "basemap_realign"

class TaskStatus(enum.Enum):
    pending = "pending"
    running = "running"
    completed = "completed"
    failed = "failed"
```

---

## API 레퍼런스

### 인증

| 메서드 | 엔드포인트        | 설명                      | 인증     |
| ------ | ----------------- | ------------------------- | -------- |
| POST   | `/auth/login`     | Google OAuth URL 가져오기 | 없음     |
| GET    | `/auth/callback`  | OAuth 콜백 (리다이렉트)   | 없음     |
| POST   | `/auth/exchange`  | 인증 코드 → 토큰          | 없음     |
| POST   | `/auth/refresh`   | 액세스 토큰 갱신          | 없음     |
| POST   | `/auth/logout`    | 리프레시 토큰 폐기        | 필요     |
| GET    | `/auth/me`        | 현재 사용자 정보          | 필요     |
| GET    | `/auth/dev-login` | 개발 모드 가짜 로그인     | DEV_MODE |

### 업로드

| 메서드 | 엔드포인트                    | 설명                            | 인증 |
| ------ | ----------------------------- | ------------------------------- | ---- |
| POST   | `/uploads/init`               | 멀티파트 업로드 초기화          | 필요 |
| POST   | `/uploads/complete`           | 업로드 완료 → 태스크 트리거     | 필요 |
| GET    | `/uploads`                    | 사용자 업로드 목록              | 필요 |
| GET    | `/uploads/{id}`               | 업로드 상세                     | 필요 |
| GET    | `/uploads/{id}/presigned-url` | 다운로드 URL (?variant=refined) | 필요 |

### 태스크

| 메서드 | 엔드포인트             | 설명               | 인증 |
| ------ | ---------------------- | ------------------ | ---- |
| GET    | `/tasks`               | 사용자 태스크 목록 | 필요 |
| GET    | `/tasks/{id}`          | 태스크 상세        | 필요 |
| GET    | `/tasks/{id}/progress` | 실시간 진행률      | 필요 |

### 씬

| 메서드 | 엔드포인트                   | 설명                              | 인증 |
| ------ | ---------------------------- | --------------------------------- | ---- |
| GET    | `/scenes`                    | 씬 목록 (?building_id, ?floor_id) | 없음 |
| GET    | `/scenes/{id}`               | 씬 상세                           | 없음 |
| GET    | `/scenes/{id}/download`      | Presigned SOG URL                 | 없음 |
| POST   | `/scenes/{id}/door-position` | 문 저장 → 정합                    | 필요 |

### 관리자 (베이스맵)

| 메서드 | 엔드포인트                      | 설명               | 인증  |
| ------ | ------------------------------- | ------------------ | ----- |
| GET    | `/admin/basemaps`               | 모든 베이스맵 목록 | Admin |
| POST   | `/admin/basemaps/upload`        | 후보 생성          | Admin |
| PUT    | `/admin/basemaps/{id}/approve`  | 베이스맵 승인      | Admin |
| PUT    | `/admin/basemaps/{id}/reject`   | 베이스맵 거부      | Admin |
| PUT    | `/admin/basemaps/{id}/activate` | 활성화 → 재정합    | Admin |

---

## 데이터 흐름

### 업로드 및 학습 흐름

```
1. Frontend: POST /uploads/init
   요청: { filename, file_size, building_id, floor_id, module_id }
   응답: { upload_id, presigned_urls[], part_size }

2. Frontend: 각 presigned_url에 PUT (병렬 멀티파트)

3. Frontend: POST /uploads/complete
   요청: { upload_id, parts: [{part_number, etag}] }
   → Backend가 Task 생성, Celery로 디스패치

4. Worker: tasks.training.run_3dgs_training
   → MinIO에서 다운로드
   → 파이프라인 실행 (FFmpeg → Blur → COLMAP → Gsplat → SOG)
   → 결과를 MinIO에 업로드
   → Redis 진행률 업데이트

5. Backend: WebSocket 푸시 (task_complete)
   → Frontend UI 업데이트
```

### 문 정합 흐름

```
1. Frontend: /door-select/{scene_id}에서 씬 로드
   → 사용자가 문 가우시안 선택 (브러쉬/bbox)

2. Frontend: POST /scenes/{scene_id}/door-position
   요청: { module_door_indices: number[] }
   → Backend가 door_position.json을 MinIO에 저장
   → Backend가 정합 태스크 디스패치

3. Worker: tasks.alignment.run_door_alignment
   → 다운로드: module.ply, door_position.json, basemap.ply
   → core.door_alignment.matrix_module2basemap() 호출
   → 모든 모듈 가우시안에 변환 적용
   → aligned.ply + aligned.sog를 MinIO에 업로드

4. Backend: scene_output.is_aligned = true 업데이트
```

---

## MinIO 저장소 구조

```
{bucket}/
├── users/{user_id}/{building_name}/
│   ├── web_input/                    # 원본 업로드 (비공개)
│   │   └── {filename}
│   └── 3dgs_output/                  # 학습 결과 (비공개)
│       ├── {module_name}.ply
│       ├── {module_name}.sog
│       └── refined/                  # 정제된 PLY
│           └── {module_name}.ply
│
└── buildings/{building_id}/{floor_id}/modules/{module_id}_{name}/
    ├── gsplat/                       # 학습 출력
    │   ├── {name}.ply
    │   └── {name}.sog
    ├── alignment/                    # 정합 결과
    │   ├── {name}.ply
    │   ├── {name}.sog
    │   └── metadata.json
    └── web_output/                   # 웹 뷰어용 SOG
        └── {name}.sog
```

---

## 인증 흐름

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│ Frontend │     │ Backend  │     │  Google  │     │  Redis   │
└────┬─────┘     └────┬─────┘     └────┬─────┘     └────┬─────┘
     │                │                │                │
     │ POST /auth/login                │                │
     │───────────────>│                │                │
     │                │                │                │
     │<───────────────│                │                │
     │ {auth_url}     │                │                │
     │                │                │                │
     │ Google로 리다이렉트              │                │
     │────────────────────────────────>│                │
     │                │                │                │
     │ 코드와 함께 리다이렉트            │                │
     │<────────────────────────────────│                │
     │                │                │                │
     │ GET /auth/callback?code=...     │                │
     │───────────────>│                │                │
     │                │                │                │
     │                │ 코드 교환      │                │
     │                │───────────────>│                │
     │                │<───────────────│                │
     │                │ {access_token} │                │
     │                │                │                │
     │                │ auth_code 생성                  │
     │                │───────────────────────────────>│
     │                │                │                │ (60s TTL)
     │                │                │                │
     │<───────────────│                │                │
     │ /login/callback?code=auth_code로 리다이렉트      │
     │                │                │                │
     │ POST /auth/exchange             │                │
     │───────────────>│                │                │
     │                │ 코드 검증      │                │
     │                │───────────────────────────────>│
     │                │<───────────────────────────────│
     │                │                │                │
     │<───────────────│                │                │
     │ {access_token, refresh_token}   │                │
     │                │                │                │
     │ localStorage에 저장             │                │
     ▼                │                │                │
```

**토큰 만료**

- Access Token: 30분
- Refresh Token: 7일

---

## 배포

### Docker Compose 서비스

| 서비스   | 이미지                | 노출 포트                | 볼륨                |
| -------- | --------------------- | ------------------------ | ------------------- |
| nginx    | nginx:alpine          | 80, 443                  | ./nginx/nginx.conf  |
| frontend | build:./frontend      | 3000 (내부)              | -                   |
| backend  | build:./backend       | 8000 (내부)              | ./core, ./utilities |
| postgres | postgres:16-alpine    | 5432 (내부)              | pgdata              |
| redis    | redis:7-alpine        | 6379 (PC_HOST_IP)        | redisdata           |
| rabbitmq | rabbitmq:3-management | 5672 (PC_HOST_IP), 15672 | rabbitmqdata        |
| minio    | minio                 | 9000 (PC_HOST_IP), 9001  | miniodata           |
| flower   | mher/flower           | 5555 (선택)              | -                   |

### GPU 서버 설정

```bash
# GPU 서버에서
export RABBITMQ_URL=amqp://user:pass@<PC_IP>:5672//
export REDIS_URL=redis://<PC_IP>:6379/0
export MINIO_ENDPOINT=<PC_IP>:9000

# 워커 시작
celery -A celery_app worker -Q training,alignment -c 1
```

---

## 개발 명령어

### Docker

```bash
# 모든 서비스 시작
docker-compose up -d

# 특정 서비스 재빌드
docker-compose up -d --build frontend backend

# 로그 보기
docker-compose logs -f backend

# 컨테이너 쉘 접속
docker-compose exec backend bash
docker-compose exec frontend sh
```

### 데이터베이스

```bash
# 마이그레이션 실행
docker-compose exec backend alembic upgrade head

# 새 마이그레이션 생성
docker-compose exec backend alembic revision -m "설명"

# 다운그레이드
docker-compose exec backend alembic downgrade -1
```

### 테스트

```bash
# 백엔드 테스트
docker-compose exec backend pytest

# 프론트엔드 테스트
docker-compose exec frontend npm test

# 커버리지 포함
docker-compose exec backend pytest --cov=app
```

### 로컬 개발

```bash
# 프론트엔드 (핫 리로드)
cd frontend && npm run dev

# 백엔드 (핫 리로드)
cd backend && uvicorn app.main:app --reload --port 8000

# 워커 (로컬)
cd worker && celery -A celery_app worker -Q training,alignment -l INFO
```

---

## 주요 구현 가이드

### 새 파이프라인 모듈 추가

1. `worker/pipeline/my_module.py` 생성:

   ```python
   from .base import PipelineModule

   class MyModule(PipelineModule):
       @property
       def name(self) -> str:
           return "my_module"

       def run(self, input_path: str) -> str:
           # input_path 디렉토리 처리
           output_path = f"{input_path}_output"
           # ... 처리 ...
           return output_path

       def validate_input(self, input_path: str) -> bool:
           return os.path.isdir(input_path)
   ```

2. `worker/tasks/training.py` 파이프라인 시퀀스에 등록.

### 새 API 엔드포인트 추가

1. `backend/app/api/my_endpoint.py`에 라우트 생성
2. `backend/app/schemas/`에 스키마 추가
3. `backend/app/main.py`에 라우터 등록

### 새 뷰어 도구 추가

1. `frontend/src/components/viewer/tools/useMyTool.ts`에 훅 생성
2. `SplatViewer.tsx` 또는 `RefineViewer.tsx`에 통합
3. 도구 패널에 UI 컨트롤 추가

---

## 환경 변수 레퍼런스

```env
# PostgreSQL
POSTGRES_USER=3dgs
POSTGRES_PASSWORD=<비밀>
POSTGRES_DB=3dgs_platform

# Redis
REDIS_PASSWORD=<비밀>
REDIS_HOST=redis

# RabbitMQ
RABBITMQ_DEFAULT_USER=3dgs
RABBITMQ_DEFAULT_PASS=<비밀>

# MinIO
MINIO_ENDPOINT=minio:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=<비밀>
MINIO_BUCKET=3dgs-platform
MINIO_PUBLIC_ENDPOINT=localhost:9000

# JWT
JWT_SECRET_KEY=<랜덤-256비트-키>
JWT_ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=30
REFRESH_TOKEN_EXPIRE_DAYS=7

# Google OAuth
GOOGLE_CLIENT_ID=<google-console에서>
GOOGLE_CLIENT_SECRET=<google-console에서>

# Frontend
NEXT_PUBLIC_API_URL=/api
NEXT_PUBLIC_KAKAO_MAP_KEY=<kakao-key>

# 선택사항
PC_HOST_IP=<gpu서버-접근가능-ip>
PUBLIC_BASE_URL=https://example.com
DEV_MODE=false
CORS_EXTRA_ORIGINS=http://localhost:3000
```

---

_최종 업데이트: 2026-04-10_
