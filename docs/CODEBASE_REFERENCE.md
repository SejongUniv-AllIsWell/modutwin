# 3DGS Digital Twin Platform - Codebase Reference

> **Purpose**: This document serves as a technical reference for development work on the 3DGS Digital Twin Platform. It provides comprehensive architectural details, file locations, and implementation patterns.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Frontend Structure](#frontend-structure)
3. [Backend Structure](#backend-structure)
4. [Worker & Pipeline](#worker--pipeline)
5. [Core Algorithms](#core-algorithms)
6. [Database Schema](#database-schema)
7. [API Reference](#api-reference)
8. [Data Flow](#data-flow)
9. [MinIO Storage Layout](#minio-storage-layout)
10. [Authentication Flow](#authentication-flow)
11. [Deployment](#deployment)
12. [Development Commands](#development-commands)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                       User Browser                          │
└─────────────────────────┬───────────────────────────────────┘
                          │ HTTPS
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    Nginx (80/443)                           │
│  • Rate limiting (API: 30/s, Auth: 30/min, MinIO: 100/s)   │
│  • Reverse proxy, WebSocket upgrade                        │
└──────┬──────────────────┬──────────────────┬───────────────┘
       │                  │                  │
       ▼                  ▼                  ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐
│   Frontend   │  │   Backend    │  │  MinIO (presigned)   │
│  Next.js:3k  │  │  FastAPI:8k  │  │       :9000          │
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
                                         │ (Network via PC_HOST_IP)
                                         ▼
                              ┌─────────────────────┐
                              │    GPU Server       │
                              │   Celery Worker     │
                              │  • training queue   │
                              │  • alignment queue  │
                              └─────────────────────┘
```

### Tech Stack Summary

| Component | Technology | Port |
|-----------|------------|------|
| Frontend | Next.js 14, React 18, TypeScript, Tailwind, PlayCanvas 2.x | 3000 |
| Backend | FastAPI, SQLAlchemy (async), Pydantic | 8000 |
| Database | PostgreSQL 16 | 5432 |
| Cache | Redis 7 | 6379 |
| Queue | RabbitMQ 3 | 5672 |
| Storage | MinIO (S3-compatible) | 9000 |
| Worker | Celery (GPU server) | N/A |
| Proxy | Nginx | 80/443 |

---

## Frontend Structure

```
frontend/
├── src/
│   ├── app/                          # Next.js App Router
│   │   ├── layout.tsx                # Root layout (AuthProvider, Navbar)
│   │   ├── page.tsx                  # Landing page (/)
│   │   ├── login/
│   │   │   ├── page.tsx              # Login redirect
│   │   │   └── callback/page.tsx     # OAuth callback handler
│   │   ├── dashboard/page.tsx        # User dashboard
│   │   ├── upload/page.tsx           # File upload interface
│   │   ├── explore/page.tsx          # Browse buildings/floors
│   │   ├── buildings/[name]/page.tsx # Building detail
│   │   ├── door-select/[scene_id]/   # Door selection (edit mode)
│   │   ├── viewer/page.tsx           # Main 3DGS viewer
│   │   └── admin/basemaps/page.tsx   # Admin basemap management
│   │
│   ├── components/
│   │   ├── viewer/
│   │   │   ├── SplatViewerCore.tsx   # PlayCanvas engine wrapper (~520 lines)
│   │   │   │   • Canvas management, camera controls (fly/orbit)
│   │   │   │   • GPU texture access via getSplatData()
│   │   │   │   • Exposes ref: getApp(), getCamera(), onUpdate()
│   │   │   │
│   │   │   ├── SplatViewer.tsx       # Editor UI wrapper (~175 lines)
│   │   │   │   • Edit mode vs readonly mode
│   │   │   │   • Tool integration (selector, transform, door, pivot)
│   │   │   │
│   │   │   ├── RefineViewer.tsx      # Refinement viewer
│   │   │   │   • Plane-based wall clipping UI
│   │   │   │
│   │   │   └── tools/
│   │   │       ├── useGaussianSelector.tsx  # Brush/BBox selection
│   │   │       ├── useTransformTool.ts      # Move/rotate gizmo
│   │   │       ├── useDoorAnimation.ts      # Door open/close animation
│   │   │       ├── usePivotEditor.ts        # Hinge axis editing
│   │   │       ├── useRefineTool.tsx        # Plane-based refinement
│   │   │       ├── gpuSync.ts               # GPU texture sync
│   │   │       └── quatUtils.ts             # Quaternion math
│   │   │
│   │   ├── map/                      # KakaoMap integration
│   │   ├── upload/                   # Upload components
│   │   └── dashboard/                # Dashboard components
│   │
│   ├── lib/
│   │   ├── api.ts                    # API client singleton (~125 lines)
│   │   │   • Token management (auto-refresh on 401)
│   │   │   • get<T>(), post<T>(), put<T>() methods
│   │   │
│   │   ├── auth.tsx                  # Auth context (~75 lines)
│   │   │   • AuthProvider, useAuth() hook
│   │   │   • Google OAuth login/logout
│   │   │
│   │   └── ws.ts                     # WebSocket client
│   │       • Real-time progress, task_complete, task_failed
│   │
│   └── types/
│       └── index.ts                  # TypeScript interfaces
│           • User, Building, Floor, Module
│           • Upload, Task, Scene, WsMessage
│
├── package.json                      # Dependencies
├── tsconfig.json                     # TypeScript config
├── tailwind.config.js                # Tailwind config (dark theme)
└── next.config.js                    # Next.js config
```

### Key Frontend Patterns

**Viewer Mode Selection** (`/viewer?mode=...`)
```typescript
// viewer/page.tsx
const mode = searchParams.get('mode');
if (mode === 'refine') return <RefineViewer />;
return <SplatViewer mode={mode === 'align' ? 'edit' : 'readonly'} />;
```

**SplatViewerCore Ref Interface**
```typescript
interface SplatViewerCoreRef {
  getApp(): pc.Application;
  getCamera(): pc.Entity;
  getCanvas(): HTMLCanvasElement;
  getSplatData(): GaussianSplatData;  // GPU texture access
  onUpdate(callback: (dt: number) => void): () => void;
  drawLine(start: pc.Vec3, end: pc.Vec3, color: pc.Color): void;
  float2Half(f: number): number;
  half2Float(h: number): number;
}
```

**API Client Usage**
```typescript
import { apiClient } from '@/lib/api';

// Auto-handles auth tokens
const tasks = await apiClient.get<Task[]>('/tasks');
const result = await apiClient.post<Upload>('/uploads/complete', data);
```

---

## Backend Structure

```
backend/
├── app/
│   ├── main.py                       # FastAPI app initialization
│   │   • Lifespan: MinIO bucket init
│   │   • CORS, middleware, routers
│   │
│   ├── core/
│   │   ├── config.py                 # Settings (Pydantic)
│   │   │   • Database, Redis, RabbitMQ, MinIO, JWT, Google OAuth
│   │   │
│   │   ├── database.py               # Async SQLAlchemy setup
│   │   │   • Engine: pool_size=20, max_overflow=10
│   │   │   • async_sessionmaker, DeclarativeBase
│   │   │
│   │   └── security.py               # JWT, password, auth deps
│   │
│   ├── api/
│   │   ├── auth.py                   # Authentication (~316 lines)
│   │   │   • POST /auth/login        → Google OAuth URL
│   │   │   • GET  /auth/callback     → OAuth callback
│   │   │   • POST /auth/exchange     → Auth code → tokens
│   │   │   • POST /auth/refresh      → Refresh token
│   │   │   • POST /auth/logout       → Revoke token
│   │   │   • GET  /auth/me           → Current user
│   │   │
│   │   ├── uploads.py                # File uploads (~298 lines)
│   │   │   • POST /uploads/init      → Multipart init, presigned URLs
│   │   │   • POST /uploads/complete  → Finalize, trigger training
│   │   │   • GET  /uploads           → List uploads
│   │   │   • GET  /uploads/{id}      → Upload details
│   │   │   • GET  /uploads/{id}/presigned-url → Download URL
│   │   │
│   │   ├── tasks.py                  # Task management (~108 lines)
│   │   │   • GET /tasks              → List tasks
│   │   │   • GET /tasks/{id}         → Task details
│   │   │   • GET /tasks/{id}/progress → Real-time progress (Redis)
│   │   │
│   │   ├── scenes.py                 # Scene outputs (~183 lines)
│   │   │   • GET  /scenes            → List aligned scenes
│   │   │   • GET  /scenes/{id}       → Scene details
│   │   │   • GET  /scenes/{id}/download → Presigned SOG URL
│   │   │   • POST /scenes/{id}/door-position → Save door, align
│   │   │
│   │   ├── basemaps.py               # Admin basemaps (~193 lines)
│   │   │   • GET  /admin/basemaps    → List basemaps
│   │   │   • POST /admin/basemaps/upload → Create candidate
│   │   │   • PUT  /admin/basemaps/{id}/approve
│   │   │   • PUT  /admin/basemaps/{id}/reject
│   │   │   • PUT  /admin/basemaps/{id}/activate
│   │   │
│   │   ├── buildings.py              # Building/floor/module CRUD
│   │   ├── notifications.py          # User notifications
│   │   ├── refine.py                 # Refinement endpoints
│   │   └── ws.py                     # WebSocket handler
│   │
│   ├── models/
│   │   └── __init__.py               # SQLAlchemy ORM models
│   │       • User, Session, AccessLog
│   │       • Building, Floor, Module
│   │       • Upload, Task, SceneOutput
│   │       • Basemap, Notification
│   │
│   ├── schemas/                      # Pydantic schemas
│   │   └── (request/response models)
│   │
│   ├── services/
│   │   ├── minio_service.py          # MinIO operations (~123 lines)
│   │   │   • ensure_bucket(), init_multipart_upload()
│   │   │   • get_presigned_upload_urls(), complete_multipart_upload()
│   │   │   • get_presigned_download_url(), upload_from_file()
│   │   │
│   │   ├── celery_service.py         # Task dispatch (~63 lines)
│   │   │   • dispatch_training_task()
│   │   │   • dispatch_alignment_task()
│   │   │
│   │   ├── auth_code_service.py      # Redis auth codes
│   │   └── notification_service.py   # WS + DB notifications
│   │
│   └── middleware/
│       └── access_log.py             # Request logging
│
└── alembic/
    ├── env.py                        # Migration config
    └── versions/
        ├── 82d4dfe40750_initial.py   # Initial schema
        └── 0001_add_building_*.py    # Building hierarchy
```

### Key Backend Patterns

**Dependency Injection**
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

**Upload Quota Validation**
```python
# uploads.py - init endpoint
MAX_UPLOADS = 100
MAX_TOTAL_SIZE = 200 * 1024 * 1024 * 1024  # 200GB

# Checked before allowing new uploads
```

**Task Dispatch Pattern**
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

## Worker & Pipeline

```
worker/
├── celery_app.py                     # Celery configuration
│   • Broker: RabbitMQ
│   • Backend: Redis
│   • Queues: training, alignment
│   • prefetch_multiplier=1, task_acks_late=True
│
├── tasks/
│   ├── training.py                   # 3DGS training task
│   │   • Task: tasks.training.run_3dgs_training
│   │   • Input: upload_id, minio_input_key, building/floor/module
│   │   • Flow: Download → Validate → Pipeline → Upload
│   │
│   └── alignment.py                  # Door alignment task
│       • Task: tasks.alignment.run_door_alignment
│       • Input: ply_key, door_position_key, basemap_key
│       • Flow: Download → Align → Transform → Upload
│
├── pipeline/
│   ├── base.py                       # PipelineModule ABC
│   │   class PipelineModule(ABC):
│   │       @property
│   │       def name(self) -> str: ...
│   │       def run(self, input_path: str) -> str: ...
│   │       def validate_input(self, input_path: str) -> bool: ...
│   │       def cleanup(self, path: str): ...
│   │
│   ├── runner.py                     # Pipeline orchestrator
│   ├── sog_converter.py              # PLY → SOG conversion
│   ├── ffmpeg_module.py              # Video → frames
│   ├── blur_detection.py             # Frame quality filter
│   ├── colmap_module.py              # Structure from motion
│   └── gsplat_module.py              # Gaussian splatting training
│
├── minio_helper.py                   # MinIO download/upload
│   • download_file(minio_key, local_path)
│   • upload_file(local_path, minio_key)
│
└── redis_helper.py                   # Progress tracking
    • update_progress(task_id, percent, module_name)
    • clear_progress(task_id)
```

### Pipeline Module Contract

```python
class MyModule(PipelineModule):
    @property
    def name(self) -> str:
        return "my_module"

    def run(self, input_path: str) -> str:
        """
        Process input and return output path.
        Must be a directory path for inter-module communication.
        """
        output_path = self._process(input_path)
        return output_path

    def validate_input(self, input_path: str) -> bool:
        """Return True if input is valid."""
        return os.path.exists(input_path)
```

### Training Pipeline Flow

```
Video/Images
    │
    ▼
┌──────────────┐
│   FFmpeg     │  Extract frames (2 FPS)
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ BlurDetect   │  Filter blurry frames
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   COLMAP     │  Structure from motion (cameras.bin, points3D.bin)
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   Gsplat     │  Train 3D Gaussian model → PLY
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ SOGConverter │  Convert PLY → SOG (web format)
└──────────────┘
```

---

## Core Algorithms

```
core/
├── door_alignment/                   # RANSAC + SVD registration
│   └── align.py
│       • _extract_principal_axes(points) → (centroid, ax0, ax1, ax2)
│       • _ransac_plane(points) → (normal, inliers_mask)
│       • build_door_frame(points) → (F[4x4], v_range)
│       • matrix_module2basemap(pts_mod, pts_base) → T[4x4]
│       • apply_transform(T, points) → transformed_points
│
├── refine_module/                    # Plane-based clipping
│   ├── clip.py
│   │   • determine_outside(xyz, normal, d) → (mask, dist)
│   │   • clip_single_plane(ply, normal, d, out, thickness) → n_removed
│   │
│   └── flat_opaque.py               # Wall attachment
│
├── select_gaussians/                 # Gaussian selection
│   ├── manual.py                    # Brush/BBox tools
│   └── auto.py                      # SAM3-based auto selection
│       • 5-step pipeline:
│       • 1. Load model (PLY/PT)
│       • 2. SAM3 segmentation on images
│       • 3. Extract contributing Gaussians
│       • 4. Aggregate + DBSCAN filter
│       • 5. Export PLY + metadata
│
└── grouping/                         # Semantic grouping
    └── module.py
```

### Door Alignment Algorithm

```
Input: module_door_points, basemap_door_points

1. RANSAC Plane Fitting
   • Remove outliers (handles, edges)
   • Robust plane normal estimation

2. Build Local Frame (for each door)
   • SVD → principal axes
   • Align normal outward (density heuristic)
   • Align vertical axis upward
   • F = [u | v | n | centroid]

3. Compute Scale
   • s = v_range_basemap / v_range_module

4. Compute Transform
   • T = F_basemap @ Scale @ F_module⁻¹

Output: 4x4 homogeneous transformation matrix
```

---

## Database Schema

### Entity Relationship

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

### Table Details

| Table | Key Columns | Notes |
|-------|-------------|-------|
| **users** | id (UUID), google_id, email, role (user/admin) | Google OAuth |
| **sessions** | user_id, refresh_token_hash, expires_at | JWT refresh |
| **access_logs** | ip, endpoint, method, status_code, timestamp | Audit trail |
| **buildings** | id (UUID), name (unique) | Top-level container |
| **floors** | building_id, floor_number | Unique per building |
| **modules** | floor_id, name | Unique per floor |
| **uploads** | user_id, module_id, minio_path, ply_target, status | File tracking |
| **tasks** | upload_id, celery_task_id, task_type, status, progress | Job tracking |
| **scene_outputs** | task_id, module_id, ply_path, sog_path, is_aligned | Results |
| **basemaps** | floor_id, version, status (pending/approved), is_active | Floor basemap |
| **notifications** | user_id, message, type, is_read | User alerts |

### Enums

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

## API Reference

### Authentication

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| POST | `/auth/login` | Get Google OAuth URL | None |
| GET | `/auth/callback` | OAuth callback (redirects) | None |
| POST | `/auth/exchange` | Auth code → tokens | None |
| POST | `/auth/refresh` | Refresh access token | None |
| POST | `/auth/logout` | Revoke refresh token | Required |
| GET | `/auth/me` | Current user info | Required |
| GET | `/auth/dev-login` | Dev mode fake login | DEV_MODE |

### Uploads

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| POST | `/uploads/init` | Init multipart upload | Required |
| POST | `/uploads/complete` | Complete upload → trigger task | Required |
| GET | `/uploads` | List user uploads | Required |
| GET | `/uploads/{id}` | Upload details | Required |
| GET | `/uploads/{id}/presigned-url` | Download URL (?variant=refined) | Required |

### Tasks

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| GET | `/tasks` | List user tasks | Required |
| GET | `/tasks/{id}` | Task details | Required |
| GET | `/tasks/{id}/progress` | Real-time progress | Required |

### Scenes

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| GET | `/scenes` | List scenes (?building_id, ?floor_id) | None |
| GET | `/scenes/{id}` | Scene details | None |
| GET | `/scenes/{id}/download` | Presigned SOG URL | None |
| POST | `/scenes/{id}/door-position` | Save door → align | Required |

### Admin (Basemaps)

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| GET | `/admin/basemaps` | List all basemaps | Admin |
| POST | `/admin/basemaps/upload` | Create candidate | Admin |
| PUT | `/admin/basemaps/{id}/approve` | Approve basemap | Admin |
| PUT | `/admin/basemaps/{id}/reject` | Reject basemap | Admin |
| PUT | `/admin/basemaps/{id}/activate` | Activate → realign | Admin |

---

## Data Flow

### Upload & Training Flow

```
1. Frontend: POST /uploads/init
   Request: { filename, file_size, building_id, floor_id, module_id }
   Response: { upload_id, presigned_urls[], part_size }

2. Frontend: PUT to each presigned_url (parallel multipart)

3. Frontend: POST /uploads/complete
   Request: { upload_id, parts: [{part_number, etag}] }
   → Backend creates Task, dispatches to Celery

4. Worker: tasks.training.run_3dgs_training
   → Download from MinIO
   → Run pipeline (FFmpeg → Blur → COLMAP → Gsplat → SOG)
   → Upload results to MinIO
   → Update Redis progress

5. Backend: WebSocket push (task_complete)
   → Frontend updates UI
```

### Door Alignment Flow

```
1. Frontend: Load scene in /door-select/{scene_id}
   → User selects door Gaussians (brush/bbox)

2. Frontend: POST /scenes/{scene_id}/door-position
   Request: { module_door_indices: number[] }
   → Backend saves door_position.json to MinIO
   → Backend dispatches alignment task

3. Worker: tasks.alignment.run_door_alignment
   → Download: module.ply, door_position.json, basemap.ply
   → Call core.door_alignment.matrix_module2basemap()
   → Apply transform to all module Gaussians
   → Upload aligned.ply + aligned.sog to MinIO

4. Backend: Update scene_output.is_aligned = true
```

---

## MinIO Storage Layout

```
{bucket}/
├── users/{user_id}/{building_name}/
│   ├── web_input/                    # Raw uploads (private)
│   │   └── {filename}
│   └── 3dgs_output/                  # Training results (private)
│       ├── {module_name}.ply
│       ├── {module_name}.sog
│       └── refined/                  # Refined PLY
│           └── {module_name}.ply
│
└── buildings/{building_id}/{floor_id}/modules/{module_id}_{name}/
    ├── gsplat/                       # Raw training output
    │   ├── {name}.ply
    │   └── {name}.sog
    ├── alignment/                    # Alignment results
    │   ├── {name}.ply
    │   ├── {name}.sog
    │   └── metadata.json
    └── web_output/                   # Web viewer SOG
        └── {name}.sog
```

---

## Authentication Flow

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
     │ Redirect to Google              │                │
     │────────────────────────────────>│                │
     │                │                │                │
     │ Redirect with code              │                │
     │<────────────────────────────────│                │
     │                │                │                │
     │ GET /auth/callback?code=...     │                │
     │───────────────>│                │                │
     │                │                │                │
     │                │ Exchange code  │                │
     │                │───────────────>│                │
     │                │<───────────────│                │
     │                │ {access_token} │                │
     │                │                │                │
     │                │ Generate auth_code              │
     │                │───────────────────────────────>│
     │                │                │                │ (60s TTL)
     │                │                │                │
     │<───────────────│                │                │
     │ Redirect /login/callback?code=auth_code          │
     │                │                │                │
     │ POST /auth/exchange             │                │
     │───────────────>│                │                │
     │                │ Verify code    │                │
     │                │───────────────────────────────>│
     │                │<───────────────────────────────│
     │                │                │                │
     │<───────────────│                │                │
     │ {access_token, refresh_token}   │                │
     │                │                │                │
     │ Store in localStorage           │                │
     ▼                │                │                │
```

**Token Expiry**
- Access Token: 30 minutes
- Refresh Token: 7 days

---

## Deployment

### Docker Compose Services

| Service | Image | Exposed Ports | Volume |
|---------|-------|---------------|--------|
| nginx | nginx:alpine | 80, 443 | ./nginx/nginx.conf |
| frontend | build:./frontend | 3000 (internal) | - |
| backend | build:./backend | 8000 (internal) | ./core, ./utilities |
| postgres | postgres:16-alpine | 5432 (internal) | pgdata |
| redis | redis:7-alpine | 6379 (PC_HOST_IP) | redisdata |
| rabbitmq | rabbitmq:3-management | 5672 (PC_HOST_IP), 15672 | rabbitmqdata |
| minio | minio | 9000 (PC_HOST_IP), 9001 | miniodata |
| flower | mher/flower | 5555 (optional) | - |

### GPU Server Setup

```bash
# On GPU server
export RABBITMQ_URL=amqp://user:pass@<PC_IP>:5672//
export REDIS_URL=redis://<PC_IP>:6379/0
export MINIO_ENDPOINT=<PC_IP>:9000

# Start worker
celery -A celery_app worker -Q training,alignment -c 1
```

---

## Development Commands

### Docker

```bash
# Start all services
docker-compose up -d

# Rebuild specific services
docker-compose up -d --build frontend backend

# View logs
docker-compose logs -f backend

# Enter container shell
docker-compose exec backend bash
docker-compose exec frontend sh
```

### Database

```bash
# Run migrations
docker-compose exec backend alembic upgrade head

# Create new migration
docker-compose exec backend alembic revision -m "description"

# Downgrade
docker-compose exec backend alembic downgrade -1
```

### Testing

```bash
# Backend tests
docker-compose exec backend pytest

# Frontend tests
docker-compose exec frontend npm test

# With coverage
docker-compose exec backend pytest --cov=app
```

### Local Development

```bash
# Frontend (hot reload)
cd frontend && npm run dev

# Backend (hot reload)
cd backend && uvicorn app.main:app --reload --port 8000

# Worker (local)
cd worker && celery -A celery_app worker -Q training,alignment -l INFO
```

---

## Key Implementation Notes

### Adding a New Pipeline Module

1. Create `worker/pipeline/my_module.py`:
   ```python
   from .base import PipelineModule

   class MyModule(PipelineModule):
       @property
       def name(self) -> str:
           return "my_module"

       def run(self, input_path: str) -> str:
           # Process input_path directory
           output_path = f"{input_path}_output"
           # ... processing ...
           return output_path

       def validate_input(self, input_path: str) -> bool:
           return os.path.isdir(input_path)
   ```

2. Register in `worker/tasks/training.py` pipeline sequence.

### Adding a New API Endpoint

1. Create route in `backend/app/api/my_endpoint.py`
2. Add schemas in `backend/app/schemas/`
3. Register router in `backend/app/main.py`

### Adding a New Viewer Tool

1. Create hook in `frontend/src/components/viewer/tools/useMyTool.ts`
2. Integrate in `SplatViewer.tsx` or `RefineViewer.tsx`
3. Add UI controls in the tool panel

---

## Environment Variables Reference

```env
# PostgreSQL
POSTGRES_USER=3dgs
POSTGRES_PASSWORD=<secret>
POSTGRES_DB=3dgs_platform

# Redis
REDIS_PASSWORD=<secret>
REDIS_HOST=redis

# RabbitMQ
RABBITMQ_DEFAULT_USER=3dgs
RABBITMQ_DEFAULT_PASS=<secret>

# MinIO
MINIO_ENDPOINT=minio:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=<secret>
MINIO_BUCKET=3dgs-platform
MINIO_PUBLIC_ENDPOINT=localhost:9000

# JWT
JWT_SECRET_KEY=<random-256-bit-key>
JWT_ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=30
REFRESH_TOKEN_EXPIRE_DAYS=7

# Google OAuth
GOOGLE_CLIENT_ID=<from-google-console>
GOOGLE_CLIENT_SECRET=<from-google-console>

# Frontend
NEXT_PUBLIC_API_URL=/api
NEXT_PUBLIC_KAKAO_MAP_KEY=<kakao-key>

# Optional
PC_HOST_IP=<gpu-server-accessible-ip>
PUBLIC_BASE_URL=https://example.com
DEV_MODE=false
CORS_EXTRA_ORIGINS=http://localhost:3000
```

---

*Last updated: 2026-04-10*
