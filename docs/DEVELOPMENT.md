# 3DGS Digital Twin Platform — 개발 환경 설정

개발팀원 전용 로컬 개발 환경 설정 가이드입니다.

---

## 기술 스택

| 역할       | 기술                                       |
| ---------- | ------------------------------------------ |
| Frontend   | Next.js (App Router, TypeScript, Tailwind) |
| Backend    | FastAPI + SQLAlchemy (async) + Alembic     |
| Database   | PostgreSQL 16                              |
| Cache      | Redis 7                                    |
| Storage    | MinIO (S3 호환)                            |
| Queue      | RabbitMQ                                   |
| GPU Worker | Celery (별도 머신)                         |
| 3DGS 뷰어  | PlayCanvas Engine (SOG 포맷)               |
| 지도       | KakaoMap API                               |
| 인증       | Google OAuth 2.0 + JWT                     |
| 프록시     | Nginx                                      |

---

## 로컬 개발 환경 설정

### 사전 요구사항

- [Docker](https://docs.docker.com/get-docker/) & Docker Compose
- KakaoMap API 키 ([Kakao Developers](https://developers.kakao.com) → 내 애플리케이션 → 앱 키)
- Google OAuth 클라이언트 키 ([Google Cloud Console](https://console.cloud.google.com) → API 및 서비스 → 사용자 인증 정보 → OAuth 2.0 클라이언트 ID 생성)

### 1. 저장소 클론

```bash
git clone https://github.com/UserPjh/3dgs-platform.git
cd 3dgs-platform
```

### 2. 환경변수 설정

```bash
cp .env.example .env
```

`.env`를 열어 아래 항목을 입력합니다.

```env
NEXT_PUBLIC_KAKAO_MAP_KEY=발급받은_카카오맵_키
NEXT_PUBLIC_KAKAO_REST_API_KEY=발급받은_카카오_REST_키

GOOGLE_CLIENT_ID=발급받은_구글_클라이언트_ID
GOOGLE_CLIENT_SECRET=발급받은_구글_클라이언트_시크릿
```

> 나머지 항목은 `.env.example`의 기본값으로 로컬 개발이 가능합니다.  
> `DEV_MODE=true` 상태에서는 Google OAuth 없이 개발자 로그인(`/api/auth/dev-login`)을 사용할 수 있습니다.

### 3. 실행

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

> `docker-compose.local.yml`은 SSL 인증서 없이 HTTP로만 동작하는 로컬 전용 nginx 설정입니다.  
> 운영용 `docker-compose.yml` 단독 실행은 SSL 인증서가 필요하므로 로컬에서는 사용하지 마세요.

### 4. DB 마이그레이션

컨테이너가 모두 기동된 후 한 번 실행합니다.

```bash
docker compose exec backend alembic upgrade head
```

### 5. 접속

| 서비스             | URL                       |
| ------------------ | ------------------------- |
| 웹사이트           | http://localhost          |
| API 문서 (Swagger) | http://localhost/api/docs |
| MinIO 콘솔         | http://localhost:9001     |
| RabbitMQ 콘솔      | http://localhost:15673    |

MinIO 콘솔 / RabbitMQ 콘솔 기본 계정은 `.env`의 `MINIO_ACCESS_KEY` / `RABBITMQ_DEFAULT_USER` 값입니다.

### 6. 개발자 로그인 (DEV_MODE)

`DEV_MODE=true` 상태에서는 Google OAuth 없이 아래 URL로 바로 로그인할 수 있습니다.

```
http://localhost/api/auth/dev-login
```

접속하면 가짜 사용자(`dev@localhost`)로 JWT가 자동 발급되어 로그인 상태가 됩니다.

---

## 유용한 명령어

```bash
# 서비스 상태 확인
docker compose ps

# 로그 실시간 확인
docker compose logs -f backend
docker compose logs -f frontend

# DB 마이그레이션 (모델 변경 후)
docker compose exec backend alembic upgrade head

# 서비스 중단
docker compose -f docker-compose.yml -f docker-compose.local.yml down
```

---

## GPU 워커 (선택사항)

3DGS 학습 파이프라인 실행에는 별도 GPU 머신에서 Celery 워커가 필요합니다.  
GPU 없이도 업로드·뷰어·지도 기능은 정상 동작합니다.

`worker/` 디렉토리로 이동 후 `.env`를 설정합니다.

```env
RABBITMQ_URL=amqp://root:changeme@<메인서버_IP>:5672//
REDIS_URL=redis://:changeme@<메인서버_IP>:6379/0
MINIO_ENDPOINT=<메인서버_IP>:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=changeme123
```

워커 실행:

```bash
pip install -r requirements.txt
celery -A celery_app worker -Q training,alignment -c 1
```

---

## 모니터링 (선택)

Flower (Celery 작업 모니터링)를 활성화하려면:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml --profile monitoring up -d
```

접속: http://localhost:5555 (`.env`의 `FLOWER_USER` / `FLOWER_PASSWORD` 사용)

---

## 운영 배포

운영 환경에서는 SSL 인증서와 추가 설정이 필요합니다.

```bash
# 1. nginx/certs/ 에 인증서 배치
#    nginx/certs/cloudflare-origin.crt
#    nginx/certs/cloudflare-origin.key

# 2. .env 수정
DEV_MODE=false
PUBLIC_BASE_URL=https://your-domain.com
MINIO_PUBLIC_ENDPOINT=your-domain.com   # nginx가 MinIO presigned URL을 프록시

# 3. Google OAuth 설정
#    Google Cloud Console → 승인된 리디렉션 URI에 추가:
#    https://your-domain.com/api/auth/google/callback

# 4. 실행
docker compose up -d
```

---

## 프로젝트 구조

```
/
├── frontend/                   # Next.js
├── backend/                    # FastAPI
├── worker/                     # Celery GPU 워커
├── nginx/
│   ├── nginx.conf              # 운영용 (SSL 필요)
│   └── nginx.local.conf        # 로컬 개발용 (HTTP only)
├── docker-compose.yml          # 운영용
├── docker-compose.local.yml    # 로컬 개발 오버라이드
└── .env.example
```
