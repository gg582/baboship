# NukeDB Global Route MVP

CWIST와 NukeDB를 결합한 최소 실행 가능 앱입니다. 고성능 계산 엔진은 C로 작성되었으며, Java 계층 없이도 곧바로 국제 노선 효율을 조회할 수 있습니다. 코드/주석은 모두 영어로 유지하고, 설명과 문서는 한국어로 제공합니다.

## 구성 요소

- `src/nuke_flight.c`: 공항·노선 데이터를 수직 배열(Vertical Arrays)에 적재하고, CWIST IO 큐(worker) + libttak 메모리 제어로 최대 3회 환승까지 스택 기반 탐색을 수행합니다.
- `src/server.c`: CWIST HTTP 레이어. `/routes`와 `/health` 엔드포인트를 제공하며, CWIST 일반 DB(`data/meta.db`)를 통해 검색 감사 로그를 남깁니다.
- `scripts/create_sample_db.py`: 즉시 실행 가능한 샘플 NukeDB 생성기.
- `scripts/download_openflights.py`: OpenFlights 원본 CSV를 `data/raw`에 내려받는 표준 라이브러리 기반 스크립트.
- `scripts/ingest_openflights.py`: OpenFlights CSV를 Nuke 포맷으로 변환하는 오프라인 툴.
- `docs/DATA_SETUP.md`: 실제 데이터를 내려받지 못할 때의 수동 배치 절차.

## 빌드 & 실행

1. **의존성 컴파일**
   ```bash
   make deps
   ```
   - `lib/libttak` → libttak 메모리 관리자
   - `lib/cwist` → CWIST 웹 프레임워크 (내부 SQLite + cwist_io 포함)

2. **데이터 준비**
   - 빠른 확인: `python3 scripts/create_sample_db.py`
   - 실제 운용: `python3 scripts/download_openflights.py --dest data/raw` → `python3 scripts/ingest_openflights.py ...`
   - 옵션/수동 경로는 `docs/DATA_SETUP.md` 참고

3. **앱 빌드**
   ```bash
   make          # nukedb_app 생성
   ```

4. **실행**
   ```bash
   ./nukedb_app          # 기본 포트 8080
   PORT=9090 ./nukedb_app  # 포트 변경
   ```
   - 환경 변수 `NUKE_DB_PATH`, `META_DB_PATH`로 DB 위치를 재정의할 수 있습니다.

## API

- `GET /health`  
  엔진 상태, 로드된 공항/노선 수, 워커 수 등을 반환합니다.
- `GET /routes?from=JFK&to=LHR&maxTransfers=3&maxResults=8`  
  최대 3회 환승, 8개의 최적 경로를 탐색합니다. Great Circle 대비 효율, 누적 거리, 공항 목록을 JSON으로 돌려줍니다.

## 데이터베이스 전략

- `data/nuke_routes.db`는 **cwist_nuke_init**으로 적재하여 전량 메모리 상주 + 디스크 동기화를 유지합니다.
- `data/meta.db`는 **CWIST 일반 DB**만 사용하여 감사 로그, 설정 등 소용량 정보를 처리합니다.

두 엔진 모두 `make`만으로 준비할 수 있으며, 네트워크 접근이 어려운 환경에서도 `scripts/create_sample_db.py` 덕분에 즉시 애플리케이션을 기동할 수 있습니다. 이후 필요 시 수동으로 OpenFlights 데이터를 내려받아 Nuke 포맷으로 재배치하면 됩니다.

## WebAssembly 빌드

- `make wasm`  
  `wasm/nuke_kernel.c`를 `emcc`로 컴파일하여 `dist/wasm/nuke_kernel.{js,wasm}` 모듈을 생성합니다. 모듈은 대권거리, 경로 누적 거리, 효율 계산 함수를 WebAssembly로 제공합니다.
- `make wasm_clean`  
  WebAssembly 산출물(`build/wasm`, `dist/wasm`)을 정리합니다.

```js
import createNukeKernel from './dist/wasm/nuke_kernel.js';

const kernel = await createNukeKernel();
const gc = kernel._nuke_wasm_gc_distance(37.466, 126.440, 50.037, 8.562);

// lat/lon 쌍(double) 버퍼를 만든 뒤 모듈 메모리에 복사하면
// nuke_wasm_route_distance 호출로 총 거리를 얻을 수 있습니다.
```
