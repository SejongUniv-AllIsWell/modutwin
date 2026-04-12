# nginx.conf 디렉티브 레퍼런스

nginx 설정 파일의 구조, 문법, 그리고 리버스 프록시 환경에서 자주 사용하는 디렉티브(옵션)들을 정리한 문서입니다.

---

## 1. 설정 파일 기본 구조

nginx.conf는 **컨텍스트(context)** 라는 계층 블록으로 구성됩니다. 각 컨텍스트는 중괄호 `{}`로 감싸며, 디렉티브는 반드시 세미콜론 `;`으로 끝납니다.

```nginx
# 최상위 (main) 컨텍스트
worker_processes auto;

events {                       # events 컨텍스트
    worker_connections 1024;
}

http {                         # http 컨텍스트
    server {                   # server 컨텍스트
        location /api/ {       # location 컨텍스트
            proxy_pass http://backend:8000;
        }
    }
}
```

각 컨텍스트의 역할은 다음과 같습니다.

| 컨텍스트 | 위치 | 역할 |
|----------|------|------|
| `main` | 파일 최상위 | 워커 프로세스, PID, 에러로그 등 전역 설정 |
| `events` | main 내부 | 연결 처리 방식 설정 |
| `http` | main 내부 | HTTP 프로토콜 관련 전역 설정 |
| `server` | http 내부 | 가상 호스트(vhost) 단위 설정 |
| `location` | server 내부 | URI 경로별 요청 처리 규칙 |
| `upstream` | http 내부 | 백엔드 서버 그룹 정의 (로드밸런싱) |

---

## 2. Main 컨텍스트 디렉티브

### worker_processes

```nginx
worker_processes auto;
```

nginx가 생성하는 워커 프로세스 수를 지정합니다. `auto`로 설정하면 CPU 코어 수에 맞게 자동 할당됩니다. 수동으로 숫자를 지정할 수도 있습니다.

### worker_rlimit_nofile

```nginx
worker_rlimit_nofile 65535;
```

워커 프로세스당 열 수 있는 최대 파일 디스크립터 수입니다. `worker_connections`보다 큰 값이어야 합니다. 고트래픽 환경에서는 OS의 `ulimit`과 함께 조정합니다.

---

## 3. Events 컨텍스트 디렉티브

### worker_connections

```nginx
events {
    worker_connections 1024;
}
```

하나의 워커 프로세스가 동시에 처리할 수 있는 최대 연결 수입니다. 전체 동시 연결 수는 `worker_processes × worker_connections`가 됩니다. 리버스 프록시 환경에서는 클라이언트 연결과 업스트림 연결을 모두 소비하므로, 실제 처리 가능한 클라이언트 수는 이 값의 절반 정도입니다.

---

## 4. HTTP 컨텍스트 디렉티브

### 기본 설정

#### include

```nginx
include /etc/nginx/mime.types;
```

외부 설정 파일을 현재 위치에 삽입합니다. `mime.types`는 파일 확장자와 Content-Type을 매핑하는 표준 파일입니다. 와일드카드도 사용 가능합니다.

```nginx
include /etc/nginx/conf.d/*.conf;    # conf.d 디렉토리의 모든 .conf 파일
```

#### default_type

```nginx
default_type application/octet-stream;
```

`mime.types`에서 매핑을 찾지 못한 파일의 기본 Content-Type입니다. `application/octet-stream`은 브라우저가 파일을 다운로드하도록 유도합니다.

#### sendfile

```nginx
sendfile on;
```

커널의 `sendfile()` 시스템 콜을 사용하여 파일을 직접 전송합니다. 유저스페이스 버퍼 복사를 생략하므로 정적 파일 서빙 성능이 향상됩니다.

#### keepalive_timeout

```nginx
keepalive_timeout 65;
```

클라이언트와의 keep-alive 연결을 유지하는 시간(초)입니다. 이 시간 동안 추가 요청이 없으면 연결을 닫습니다. 기본값은 75초입니다.

#### client_max_body_size

```nginx
client_max_body_size 100m;    # 최대 100MB
client_max_body_size 0;       # 무제한
```

클라이언트가 보낼 수 있는 요청 본문의 최대 크기입니다. 이 값을 초과하면 nginx가 `413 Request Entity Too Large`를 반환합니다. 파일 업로드가 있는 서비스에서는 반드시 조정해야 합니다. `0`은 제한 없음을 의미합니다.

---

### 로깅

#### log_format

```nginx
log_format main '$remote_addr - $remote_user [$time_local] '
                '"$request" $status $body_bytes_sent '
                '"$http_referer" "$http_user_agent" '
                'rt=$request_time';
```

접근 로그의 출력 형식을 정의합니다. 자주 사용하는 변수들은 다음과 같습니다.

| 변수 | 설명 |
|------|------|
| `$remote_addr` | 클라이언트(또는 프록시) IP |
| `$remote_user` | HTTP Basic Auth 사용자명 |
| `$time_local` | 로컬 시간 |
| `$request` | 요청 라인 전체 (예: `GET /api/users HTTP/1.1`) |
| `$status` | 응답 상태 코드 |
| `$body_bytes_sent` | 응답 본문 크기 (바이트) |
| `$http_referer` | Referer 헤더 |
| `$http_user_agent` | User-Agent 헤더 |
| `$request_time` | 요청 처리 총 소요 시간 (초, 밀리초 포함) |
| `$upstream_response_time` | 업스트림 서버의 응답 시간 |
| `$upstream_connect_time` | 업스트림 연결 수립 시간 |

#### access_log / error_log

```nginx
access_log /var/log/nginx/access.log main;    # main 포맷 사용
access_log off;                               # 접근 로그 비활성화

error_log /var/log/nginx/error.log warn;      # warn 이상 레벨만 기록
```

`error_log`의 레벨은 `debug`, `info`, `notice`, `warn`, `error`, `crit`, `alert`, `emerg` 순서입니다. 운영 환경에서는 `warn` 이상을 권장합니다.

---

### map 디렉티브

```nginx
map $변수_입력 $변수_출력 {
    조건값    결과값;
    default  기본값;
}
```

입력 변수의 값에 따라 새로운 변수를 생성하는 디렉티브입니다. `http` 컨텍스트에서만 선언할 수 있지만, 생성된 변수는 모든 하위 컨텍스트에서 사용 가능합니다.

```nginx
# 실제 클라이언트 IP 결정
map $http_cf_connecting_ip $real_client_ip {
    ""      $remote_addr;       # CF-Connecting-IP 헤더가 비어있으면 remote_addr 사용
    default $http_cf_connecting_ip;   # 헤더가 있으면 그 값을 사용
}

# WebSocket 연결 업그레이드 판단
map $http_upgrade $connection_upgrade {
    default upgrade;    # Upgrade 헤더가 있으면 → "upgrade"
    ""      close;      # Upgrade 헤더가 없으면 → "close"
}
```

`map`은 요청 시점에 지연 평가(lazy evaluation)되므로, 선언 자체는 성능에 영향을 주지 않습니다.

---

### 실제 IP 복원 (real_ip_module)

프록시 체인(Cloudflare → NPM → Nginx) 환경에서 `$remote_addr`는 직전 프록시의 IP가 됩니다. `real_ip_module`은 신뢰할 수 있는 프록시가 전달한 헤더에서 실제 클라이언트 IP를 추출하여 `$remote_addr`를 덮어씁니다.

```nginx
# 이 IP 대역에서 온 요청은 "프록시"로 간주하고 헤더를 신뢰함
set_real_ip_from 172.16.0.0/12;     # Docker 내부 네트워크
set_real_ip_from 10.0.0.0/8;        # 사설 네트워크
set_real_ip_from 103.21.244.0/22;   # Cloudflare IP 대역 (예시)

# 실제 IP를 가져올 헤더 지정
real_ip_header CF-Connecting-IP;    # Cloudflare 환경
# real_ip_header X-Forwarded-For;   # 일반 프록시 환경
# real_ip_header X-Real-IP;         # 단일 프록시 환경

# 프록시 체인에서 재귀적으로 신뢰할 IP를 제거
real_ip_recursive on;
```

| 디렉티브 | 설명 |
|----------|------|
| `set_real_ip_from` | 신뢰할 프록시의 IP/CIDR. 여러 줄 사용 가능 |
| `real_ip_header` | 실제 IP가 담긴 헤더 이름 |
| `real_ip_recursive on` | X-Forwarded-For에 여러 IP가 있을 때, 신뢰 목록에 없는 가장 오른쪽 IP를 실제 IP로 사용 |

이 설정이 적용되면 `$remote_addr`, `allow/deny`, `limit_req_zone` 등이 모두 실제 클라이언트 IP 기준으로 동작합니다.

---

### Rate Limiting

#### limit_req_zone

```nginx
limit_req_zone $키 zone=이름:메모리 rate=속도;
```

요청 속도 제한의 공유 메모리 존을 정의합니다. `http` 컨텍스트에서 선언합니다.

```nginx
limit_req_zone $real_client_ip zone=api:10m rate=30r/s;
limit_req_zone $real_client_ip zone=auth:10m rate=30r/m;
```

| 매개변수 | 설명 |
|----------|------|
| `$키` | 제한 기준이 되는 변수 (보통 클라이언트 IP) |
| `zone=이름:메모리` | 존 이름과 할당할 공유 메모리 크기. 10m ≒ 약 16만 개 IP 상태 저장 |
| `rate=숫자r/s` | 초당 허용 요청 수. `r/m`은 분당 |

#### limit_req

```nginx
limit_req zone=api burst=50 nodelay;
```

`location` 또는 `server` 컨텍스트에서 실제로 제한을 적용합니다.

| 매개변수 | 설명 |
|----------|------|
| `zone=이름` | 사용할 존 |
| `burst=숫자` | 순간적으로 허용할 초과 요청 수 (버킷 크기) |
| `nodelay` | burst 내 요청을 지연 없이 즉시 처리. 없으면 rate에 맞춰 큐잉 |
| `delay=숫자` | burst 중 이 수까지는 즉시, 나머지는 큐잉 (nodelay와 함께 사용 불가) |

---

### Gzip 압축

```nginx
gzip on;                    # 압축 활성화
gzip_vary on;               # Vary: Accept-Encoding 헤더 추가 (CDN 캐시 호환)
gzip_proxied any;           # 프록시된 요청도 압축
gzip_comp_level 4;          # 압축 레벨 (1~9, 4~6 권장)
gzip_min_length 256;        # 이 크기 미만은 압축 안 함 (바이트)
gzip_types                  # 압축 대상 MIME 타입 (text/html은 항상 포함)
    text/plain
    text/css
    application/javascript
    application/json
    image/svg+xml;
```

| 디렉티브 | 기본값 | 설명 |
|----------|--------|------|
| `gzip_comp_level` | 1 | 높을수록 압축률 ↑, CPU 사용 ↑. 4~6이 균형점 |
| `gzip_min_length` | 20 | 작은 응답은 압축해도 오히려 크기가 커질 수 있음 |
| `gzip_proxied` | off | `any`는 모든 프록시 응답 압축. 세밀하게는 `expired`, `no-cache` 등 지정 가능 |

---

### 보안 헤더

```nginx
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-XSS-Protection "1; mode=block" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
```

| 헤더 | 효과 |
|------|------|
| `X-Content-Type-Options: nosniff` | 브라우저의 MIME 타입 스니핑을 차단하여 Content-Type 위장 공격 방지 |
| `X-Frame-Options: SAMEORIGIN` | 같은 출처에서만 iframe 삽입 허용 (클릭재킹 방지) |
| `X-XSS-Protection: 1; mode=block` | 브라우저 내장 XSS 필터 활성화 |
| `Referrer-Policy` | 외부 사이트로 이동 시 전달하는 Referer 정보 범위 제어 |

`always` 키워드는 에러 응답(4xx, 5xx)에도 헤더를 추가합니다. 없으면 2xx/3xx에만 적용됩니다.

---

## 5. Server 컨텍스트 디렉티브

### listen

```nginx
listen 80;                  # IPv4 포트 80
listen [::]:80;             # IPv6 포트 80
listen 443 ssl;             # HTTPS
listen 80 default_server;   # 기본 서버 블록
```

이 서버 블록이 수신할 포트와 프로토콜을 지정합니다.

### server_name

```nginx
server_name example.com www.example.com;   # 특정 도메인
server_name *.example.com;                 # 와일드카드
server_name _;                             # 모든 호스트명에 매칭 (catch-all)
```

요청의 Host 헤더와 매칭할 서버 이름입니다. `_`는 어떤 호스트명에도 매칭되는 catch-all 패턴으로, 단일 서버 블록에서 주로 사용합니다.

### resolver

```nginx
resolver 127.0.0.11 valid=10s;
```

`proxy_pass`에 변수를 사용할 때(`set $upstream ...`) nginx가 DNS를 조회할 서버를 지정합니다. `127.0.0.11`은 Docker 내장 DNS입니다.

| 매개변수 | 설명 |
|----------|------|
| `valid=시간` | DNS 응답의 캐시 유효 기간. Docker 컨테이너 재시작 시 IP가 바뀔 수 있으므로 짧게 설정 |
| `ipv6=off` | IPv6 조회를 비활성화 (Docker에서 불필요한 AAAA 조회 방지) |

---

## 6. Location 컨텍스트와 매칭 규칙

### 매칭 우선순위

```nginx
location = /exact       { ... }   # 1순위: 정확히 일치
location ^~ /prefix     { ... }   # 2순위: 접두사 일치 (정규식 탐색 중단)
location ~ \.php$       { ... }   # 3순위: 정규식 (대소문자 구분)
location ~* \.(jpg|png)$ { ... }  # 3순위: 정규식 (대소문자 무시)
location /prefix        { ... }   # 4순위: 일반 접두사 일치
location /              { ... }   # 최후 매칭: 모든 요청에 매칭
```

nginx는 요청 URI에 대해 위 순서대로 매칭을 시도합니다. `=` 매칭이 가장 우선이고, 일반 접두사 중 가장 긴 것이 선택됩니다. 정규식은 설정 파일에 나온 순서대로 첫 번째 매칭이 사용됩니다.

실전에서 흔히 혼동되는 예시는 다음과 같습니다.

```nginx
# 요청: /api/auth/login

location /api/auth/ { ... }   # ← 매칭됨 (더 긴 접두사)
location /api/      { ... }   # ← 매칭되지 않음
```

### allow / deny

```nginx
location /api/docs {
    allow 127.0.0.1;
    allow 192.168.0.0/16;
    deny all;
}
```

IP 기반 접근 제어입니다. 위에서 아래로 순서대로 평가하며, 첫 번째 매칭 규칙이 적용됩니다. `$remote_addr` 기준으로 동작하므로, 프록시 환경에서는 반드시 `real_ip_module`을 함께 설정해야 합니다.

---

## 7. 프록시 디렉티브 (핵심)

### proxy_pass

```nginx
proxy_pass http://backend:8000;
```

요청을 업스트림 서버로 전달합니다. 리버스 프록시의 핵심 디렉티브입니다.

**URI 포함 여부에 따른 동작 차이:**

```nginx
# URI 없음: 원본 요청 경로 그대로 전달
location /api/ {
    proxy_pass http://backend:8000;
    # /api/users → backend:8000/api/users
}

# URI 있음: location 매칭 부분을 URI로 대체
location /api/ {
    proxy_pass http://backend:8000/;     # 끝에 / 있음
    # /api/users → backend:8000/users    (경로 재작성됨)
}
```

**변수 사용 시 주의사항:**

```nginx
# 변수 사용 시 resolver가 필수
resolver 127.0.0.11 valid=10s;

location /api/ {
    set $upstream http://backend:8000;
    proxy_pass $upstream;
    # 변수 사용 시 URI 대체가 발생하지 않음
    # /api/users → backend:8000/api/users
}
```

변수를 사용하면 nginx가 시작 시점이 아닌 요청 시점에 DNS를 조회하므로, Docker처럼 컨테이너 IP가 변할 수 있는 환경에 적합합니다.

---

### proxy_set_header

업스트림 서버로 전달할 HTTP 헤더를 설정하거나 재정의합니다. nginx는 프록시 시 일부 헤더를 기본적으로 변경하므로, 원본 정보를 보존하려면 명시적으로 설정해야 합니다.

#### Host

```nginx
proxy_set_header Host $host;
```

업스트림 서버에 전달되는 Host 헤더를 설정합니다. 기본적으로 nginx는 `proxy_pass`에 지정한 호스트명으로 Host를 변경하는데, `$host`를 사용하면 클라이언트가 요청한 원래 도메인명을 보존합니다.

| 변수 | 값 예시 | 설명 |
|------|---------|------|
| `$host` | `example.com` | 클라이언트 요청의 Host 헤더 (포트 제외) |
| `$http_host` | `example.com:8080` | 클라이언트 요청의 Host 헤더 (포트 포함) |
| `$proxy_host` | `backend:8000` | proxy_pass에 지정한 호스트 (기본값) |

#### X-Real-IP

```nginx
proxy_set_header X-Real-IP $real_client_ip;
```

실제 클라이언트의 IP 주소를 단일 값으로 전달합니다. 백엔드 애플리케이션이 접속자 IP를 식별하는 데 사용합니다. 표준 헤더는 아니지만 nginx 환경에서 사실상의 표준(de facto standard)입니다.

#### X-Forwarded-For

```nginx
proxy_set_header X-Forwarded-For $real_client_ip;
# 또는 프록시 체인을 기록하려면:
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

요청이 거쳐온 클라이언트/프록시 IP 체인을 기록합니다.

| 변수 | 동작 |
|------|------|
| `$real_client_ip` | 실제 클라이언트 IP만 전달 (기존 체인 무시) |
| `$proxy_add_x_forwarded_for` | 기존 X-Forwarded-For에 `$remote_addr`를 추가 (체인 보존) |

Cloudflare 같은 CDN이 앞에 있으면 이미 체인이 설정되어 있으므로, 신뢰 가능한 `$real_client_ip`만 전달하는 방식이 보안상 더 안전합니다.

#### X-Forwarded-Proto

```nginx
proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
# 또는 직접 지정:
proxy_set_header X-Forwarded-Proto $scheme;
```

원래 요청의 프로토콜(http/https)을 백엔드에 전달합니다. SSL 종료가 앞단 프록시에서 이루어지는 경우, 백엔드는 이 헤더를 보고 원래 HTTPS 요청이었는지 판단합니다. 이를 통해 리다이렉트 URL 생성, 쿠키의 Secure 플래그 설정 등이 올바르게 동작합니다.

| 변수 | 설명 |
|------|------|
| `$scheme` | 현재 nginx가 받은 프로토콜 (http 또는 https) |
| `$http_x_forwarded_proto` | 앞단 프록시가 설정한 값을 그대로 전달 |

---

### 프록시 타임아웃

```nginx
proxy_connect_timeout 10s;     # 업스트림 연결 수립 대기 시간
proxy_read_timeout 300s;       # 업스트림 응답 대기 시간
proxy_send_timeout 60s;        # 업스트림에 요청 전송 대기 시간
```

| 디렉티브 | 기본값 | 설명 |
|----------|--------|------|
| `proxy_connect_timeout` | 60s | TCP 연결 수립까지의 최대 대기 시간 |
| `proxy_read_timeout` | 60s | 업스트림이 응답을 보내기까지의 최대 대기 시간. 대용량 처리가 있는 API는 늘려야 함 |
| `proxy_send_timeout` | 60s | nginx가 업스트림에 요청을 전송하는 최대 시간 |

WebSocket 연결에서는 `proxy_read_timeout`이 핑/퐁 없이 데이터가 없는 유휴 시간을 의미하므로, 장시간 연결 유지가 필요하면 큰 값(예: `86400` = 24시간)을 설정합니다.

---

### 프록시 버퍼링

```nginx
proxy_buffering off;           # 버퍼링 비활성화 (스트리밍에 적합)
proxy_buffering on;            # 버퍼링 활성화 (기본값)

# 버퍼링 활성화 시 세부 설정
proxy_buffer_size 4k;          # 응답 헤더용 버퍼
proxy_buffers 8 4k;            # 응답 본문용 버퍼 (개수 × 크기)
proxy_busy_buffers_size 8k;    # 클라이언트 전송 중에도 사용 가능한 버퍼
```

`proxy_buffering on`(기본값)이면 nginx가 업스트림 응답 전체를 메모리에 버퍼링한 후 클라이언트에 전송합니다. 업스트림 연결을 빨리 해제할 수 있어 효율적입니다.

`proxy_buffering off`는 응답을 받는 즉시 클라이언트로 전달합니다. 파일 다운로드, SSE(Server-Sent Events), 대용량 스트리밍에 적합합니다.

---

### proxy_http_version

```nginx
proxy_http_version 1.1;
```

업스트림 서버와의 통신에 사용할 HTTP 버전입니다. 기본값은 `1.0`인데, keep-alive 연결과 WebSocket 업그레이드는 HTTP/1.1이 필수이므로 명시적으로 설정해야 합니다.

---

## 8. WebSocket 프록시

WebSocket은 HTTP Upgrade 메커니즘을 사용하므로, 관련 헤더를 명시적으로 전달해야 합니다.

```nginx
# http 컨텍스트에서 map 선언
map $http_upgrade $connection_upgrade {
    default upgrade;
    ""      close;
}

# location 컨텍스트에서 적용
location /ws {
    proxy_pass http://backend:8000;
    proxy_http_version 1.1;                          # 필수
    proxy_set_header Upgrade $http_upgrade;           # 클라이언트의 Upgrade 헤더 전달
    proxy_set_header Connection $connection_upgrade;  # upgrade 또는 close 동적 결정
    proxy_set_header Host $host;
    proxy_read_timeout 86400;                         # 유휴 연결 24시간 유지
}
```

각 헤더의 역할은 다음과 같습니다.

| 헤더 | 값 | 역할 |
|------|-----|------|
| `Upgrade` | `websocket` | 프로토콜 전환을 요청 |
| `Connection` | `upgrade` | 현재 연결에서 프로토콜 전환을 수행하겠다는 선언 |

`Connection "upgrade"`를 하드코딩하면, 해당 location에 일반 HTTP 요청이 들어왔을 때도 Connection: upgrade가 전송되어 문제가 생길 수 있습니다. `map` 변수를 사용하면 Upgrade 헤더 유무에 따라 자동으로 결정됩니다.

---

## 9. Upstream 블록 (로드밸런싱)

```nginx
upstream backend_pool {
    least_conn;                             # 로드밸런싱 알고리즘

    server backend1:8000 weight=3;          # 가중치 3
    server backend2:8000 weight=1;          # 가중치 1
    server backend3:8000 backup;            # 백업 서버 (다른 서버 모두 다운 시 사용)

    keepalive 32;                           # 업스트림 연결 풀 크기
}

server {
    location /api/ {
        proxy_pass http://backend_pool;
        proxy_http_version 1.1;             # keepalive 사용 시 필수
        proxy_set_header Connection "";     # keepalive 사용 시 필수
    }
}
```

| 알고리즘 | 설명 |
|----------|------|
| (기본값) | 라운드 로빈. 순서대로 분배 |
| `least_conn` | 활성 연결이 가장 적은 서버로 분배 |
| `ip_hash` | 클라이언트 IP 기반 해시. 같은 IP는 항상 같은 서버로 (세션 고정) |
| `hash $key` | 커스텀 키 기반 해시 (예: `hash $request_uri consistent`) |

---

## 10. nginx 변수 참조표

nginx 설정에서 자주 사용하는 내장 변수들을 용도별로 분류한 표입니다.

### 요청 정보

| 변수 | 예시 값 | 설명 |
|------|---------|------|
| `$request` | `GET /api/users HTTP/1.1` | 요청 라인 전체 |
| `$request_method` | `GET` | HTTP 메서드 |
| `$request_uri` | `/api/users?page=1` | 원본 URI (인코딩, 쿼리스트링 보존) |
| `$uri` | `/api/users` | 정규화된 URI (rewrite 반영, 쿼리스트링 제외) |
| `$args` | `page=1&size=10` | 쿼리스트링 |
| `$scheme` | `http` | 프로토콜 |
| `$host` | `example.com` | Host 헤더 (포트 제외) |
| `$content_type` | `application/json` | Content-Type 헤더 |
| `$content_length` | `1024` | Content-Length 헤더 |

### 클라이언트/연결 정보

| 변수 | 예시 값 | 설명 |
|------|---------|------|
| `$remote_addr` | `192.168.1.100` | 클라이언트 IP (real_ip_module 적용 후 실제 IP) |
| `$remote_port` | `52431` | 클라이언트 포트 |
| `$server_addr` | `10.0.0.5` | 요청을 받은 서버 IP |
| `$server_port` | `80` | 요청을 받은 서버 포트 |

### HTTP 헤더 접근

```nginx
# 임의의 요청 헤더를 $http_헤더명 변수로 접근 가능
# 헤더명은 소문자로, 하이픈(-)은 언더스코어(_)로 변환
$http_user_agent          # User-Agent
$http_x_forwarded_for     # X-Forwarded-For
$http_cf_connecting_ip    # CF-Connecting-IP
$http_upgrade             # Upgrade
$http_x_forwarded_proto   # X-Forwarded-Proto
```

### 응답/업스트림 정보

| 변수 | 설명 |
|------|------|
| `$upstream_addr` | 요청을 처리한 업스트림 서버 주소 |
| `$upstream_status` | 업스트림 응답 코드 |
| `$upstream_response_time` | 업스트림 응답 시간 (초) |
| `$upstream_connect_time` | 업스트림 연결 수립 시간 |

---

## 11. 설정 검증과 리로드

```bash
# 문법 검증 (서비스 중단 없이 안전하게 확인)
nginx -t

# 설정 리로드 (무중단)
nginx -s reload

# 설정 파일 경로 확인
nginx -T    # 현재 적용된 전체 설정 출력 (include 파일 포함)
```

설정을 변경한 후에는 반드시 `nginx -t`로 검증한 뒤 `reload`하는 것이 표준 절차입니다. `restart`와 달리 `reload`는 기존 연결을 유지하면서 새 설정을 적용합니다.
