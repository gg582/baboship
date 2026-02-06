# Nuke-Format Data Preparation

이 프로젝트는 **OpenFlights** CSV 덤프를 NukeDB 엔진에 맞는 수직 배열(SQLite) 구조로 변환합니다. 네트워크 차단 환경에서도 바로 사용할 수 있도록 `data/nuke_routes.db` 샘플을 포함했지만, 실제 배포에서는 최신 데이터를 직접 내려받아 재생성하는 것을 권장합니다.

## 1. OpenFlights CSV 내려받기

### 스크립트 사용 (권장)

`scripts/download_openflights.py`는 Python 표준 라이브러리만 사용해 두 CSV를 `data/raw` 폴더로 내려받습니다.

```bash
python3 scripts/download_openflights.py --dest data/raw
```

네트워크가 차단된 경우, `--quiet`, `--force`, `--timeout` 등 옵션으로 동작을 조절하거나, URL을 직접 덮어쓸 수 있습니다.

### 완전 수동 절차

1. [https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat](https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat)  
   [https://raw.githubusercontent.com/jpatokal/openflights/master/data/routes.dat](https://raw.githubusercontent.com/jpatokal/openflights/master/data/routes.dat)  
   위 두 파일을 로컬로 저장합니다. (네트워크가 막혀 있다면, 다른 PC에서 내려받은 뒤 이 환경으로 복사하십시오.)
2. 저장한 파일을 프로젝트 폴더의 `data/raw` 아래에 배치합니다.
3. 변환을 실행합니다.

```bash
python3 scripts/ingest_openflights.py \
  --airports data/raw/airports.dat \
  --routes data/raw/routes.dat \
  --output data/nuke_routes.db
```

성공 시 `data/nuke_routes.db`가 최신 글로벌 노선 그래프를 담은 Nuke-Format DB로 교체됩니다.

## 2. 샘플 데이터로 복구하기

테스트 용도로는 기본 제공 스키마를 다시 채워 넣을 수 있습니다.

```bash
python3 scripts/create_sample_db.py   # data/nuke_routes.db 재생성
```

샘플 파일은 최소 공항/노선(5개 공항, 8개 노선)만 포함하므로, 실제 분석 정확도를 얻으려면 OpenFlights 덤프로 꼭 덮어씌우십시오.

## 3. 용량에 따른 DB 사용 지침

- `data/nuke_routes.db` : NukeDB(Hydrated SQLite) 전용. 수만 건 이상 루트를 즉시 메모리로 적재합니다.  
- `data/meta.db` : CWIST 일반 DB로, 검색 감사 로그 및 설정 같은 소용량 메타데이터만 저장합니다. 서버 실행 시 자동 생성되므로 직접 준비할 필요가 없습니다.

두 파일 모두 동일한 `data/` 디렉터리 아래에 두면, `nukedb_app`이 용량에 맞춰 적절한 엔진(CWIST 일반 DB ↔ NukeDB)을 선택해 사용합니다.
