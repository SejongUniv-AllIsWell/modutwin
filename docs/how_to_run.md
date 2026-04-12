### 1. KAKAO MAP API key 발급

```md
1. kakao developers 접속
   - https://developers.kakao.com
2. TEST 앱 선택
3. 좌측 대시보드 카카오맵 -> 사용설정 상태를 ON으로 변경
4. 좌측 대시보드 앱 -> 플랫폼 키
5. JavaScript키 수정
   - JavaScript SDK 도메인에 http://localhost 추가 후 저장
6. REST API 키 와 JavaScript 키를 복사 후 프로젝트 폴더의 .env.example 파일의
   NEXT_PUBLIC_KAKAO_REST_API_KEY=changeme
   NEXT_PUBLIC_KAKAO_MAP_KEY=changeme 를 변경
```

### 2. 환경변수 설정

```bash
cp .env.example .env
```

### 3. 실행

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

- 이미 포트가 사용중이면 docker-compose.yml에서 외부로 바인딩 되는 포트 번호를 바꿀 것

### 4. DB 마이그레이션

컨테이너가 모두 올라오면 마이그레이션 실행

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

MinIO 콘솔 / RabbitMQ 콘솔 기본 계정은 `.env`의 `MINIO_ACCESS_KEY` / `RABBITMQ_DEFAULT_USER` 값
