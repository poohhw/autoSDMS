# autoSDMS Agent Handoff (2026-03-23)

## 1) 현재 목표
- Notion 업무일지 DB에서 데이터를 읽어 ERP에 자동 등록한다.
- 일일 등록: 기타업무 + 일일 스크럼 + 업무일지
- 주간 등록: 주간 업무보고 (프로젝트별 요약)

## 2) 실행 명령

### 일일 등록 (기타업무 + 일일 스크럼 + 업무일지)

매핑만 확인 (ERP 미등록):
```powershell
npm run register:otherwork -- 2026-03-23 --dry-run
```

실제 등록:
```powershell
npm run register:otherwork -- 2026-03-23
```

화면 보면서 실행:
```powershell
npm run register:otherwork -- 2026-03-23 --headed --slow=300
```

**등록 흐름:**
1. Notion에서 해당 날짜 데이터 조회
2. `기타업무` 카테고리 → ERP 기타업무 등록 (중복 skip)
3. 일일 스크럼 등록 (전일 업무 + 금일 예정업무, 중복 skip)
4. 업무일지 등록 (business.aspx, 중복 skip)

### 주간 업무보고 등록

요약만 확인 (ERP 미등록):
```powershell
npm run register:weekly -- 2026-03-16 --dry-run
```

실제 등록:
```powershell
npm run register:weekly -- 2026-03-16
```

화면 보면서 실행:
```powershell
npm run register:weekly -- 2026-03-16 --headed --slow=300
```

**등록 흐름:**
1. 입력한 날짜가 속한 주의 월~금 데이터를 Notion에서 수집
2. 프로젝트별로 업무 내용 요약
3. ERP BusinessReport.aspx에서 해당 주차 선택 → 등록 팝업 → 프로젝트별 입력
4. 해당 주차가 드롭다운에 없으면 자동 Skip

### Notion 조회/검증

일자 조회:
```powershell
npm run dev -- 2026-03-16
```

전체 행 조회:
```powershell
npm run dev -- --all
```

## 3) 공통 옵션
| 옵션 | 설명 |
|------|------|
| `--dry-run` | Notion 데이터만 조회하고 ERP 등록하지 않음 |
| `--headed` | 브라우저 화면을 띄워서 실행 |
| `--slow=N` | 각 동작 사이에 N ms 지연 (디버깅용) |

## 4) 주요 파일
| 구분 | 파일 |
|------|------|
| 일일 등록 엔트리 | `src/registerOtherWork.ts` |
| 주간 등록 엔트리 | `src/registerWeeklyReport.ts` |
| Notion 조회 엔트리 | `src/main.ts` |
| 환경변수/프롬프트 | `src/config/env.ts`, `src/runtime/ensureEnv.ts` |
| Notion 클라이언트 | `src/notion/notionClient.ts` |
| Notion 매퍼 | `src/notion/otherWorkMapper.ts` |
| ERP 자동화 | `src/erp/otherWorkRegistrar.ts` |
| 주간 요약 로직 | `src/domain/weeklyReport.ts` |
| 날짜 유틸 | `src/domain/businessDay.ts` |
| 셀렉터 문서 | `erp-selectors.md` |

## 5) ERP 셀렉터 (확정)

### 로그인
- ID: `#inputId`
- PW: `#inputScr`
- 로그인 버튼: `#logbtnImg`

### 기타업무
- 페이지: `http://erp.gcsc.co.kr/Agile/IssuePims/OtherWork.aspx`
- 등록 버튼: `#ctl00_AgileContents_btn_PairInsert`
- 팝업 필드: `#txt_subject`, `#ddl_priority`, `#ddl_status`, `#chk_oldVersion`, `#ddl_solutioncode`, `#chk_addSprint`, `#ddl_workType`, `#ddl_workDetail`, `#txt_empnumber_txt_pm`, `#txt_finishdate_txt_date`, `#txt_workcomment`
- 확인: `#btnl_addReleaseConfirm`

### 일일 스크럼
- 페이지: `http://erp.gcsc.co.kr/Agile/Agile/DailyScrum.aspx`

### 업무일지
- 페이지: `http://erp.gcsc.co.kr/project/business.aspx?subMenuCss=tcell_addWork`

### 주간 업무보고
- 페이지: `http://erp.gcsc.co.kr/Agile/Agile/BusinessReport.aspx`
- 주차 선택: `#ctl00_AgileContents_ddl_weeklySelect`
- 등록 버튼: `#ctl00_AgileContents_btnl_addBusinessReport`
- 팝업 필드: `#ddl_MainGroup`, `#txt_SubCodeName`, `#txt_progressWorkInsert_txt`, `#txt_scheduleWorkInsert_txt`
- 항목 등록: `#btnl_businessAdd`
- 행 추가: `#btn_Business_add`
- 최종 등록: `#btn_ok`

## 6) Notion 컬럼 매핑
### 필수
- `제목` (Title)
- `날짜` 또는 `진행일` (Date)
- `카테고리` (Select: `기타업무` / `요구사항`)
- `업무내용` (Rich text)

### 선택
- `프로젝트`, `중요도`, `상태`
- `SDMS 분류사전` (Relation), `분류`, `분류상세`
- `솔루션` / `솔루션 코드`, `스프린트`
- `담당자` / `담당자 사번`
- `예정률` (Number, 예: 100)

## 7) 환경변수
| 변수 | 설명 |
|------|------|
| `NOTION_ID` | Notion 로그인 ID |
| `NOTION_PASSWORD` | Notion 로그인 비밀번호 |
| `NOTION_TOKEN` | Notion Integration Token |
| `NOTION_DATABASE_ID` | Notion 업무일지 DB ID |
| `COMPANY_ID` | ERP 로그인 ID |
| `COMPANY_PASSWORD` | ERP 로그인 비밀번호 |
| `COMPANY_LOGIN_URL` | ERP 로그인 URL (기본: `http://erp.gcsc.co.kr/login.aspx`) |
| `COMPANY_MAIN_URL` | ERP 메인 URL (기본: `http://erp.gcsc.co.kr/Agile/main.aspx`) |
| `EMPLOYEE_NAME` | 직원 이름 (ERP 검색용) |

## 8) 빌드 및 배포

| 명령어 | 용도 |
|--------|------|
| `npm run electron:dev` | 개발 모드 (빌드 → 앱 즉시 실행) |
| `npm run electron:pack` | 포터블 빌드 (`release/win-unpacked/` 폴더) |
| `npm run electron:dist` | **설치 파일 생성** (`release/autoSDMS Setup {version}.exe`) |
| `npm run electron:build-ts` | TypeScript만 빌드 (Electron 실행 안 함) |

### 설치 파일 생성 (.exe)
```powershell
npm run electron:dist
```
> TypeScript 빌드 → NSIS 설치 파일 생성

**생성 결과:**
```
release/
  autoSDMS Setup {version}.exe   ← 배포용 설치 파일
```

### 버전 관리
- `package.json` → `"version": "0.2.0"` 필드에서 관리
- 빌드 시 설치 파일명과 앱 정보에 자동 반영

| 버전 규칙 | 설명 | 예시 |
|-----------|------|------|
| **Major** (X.0.0) | 대규모 구조 변경, 호환성 깨짐 | 1.0.0 |
| **Minor** (0.X.0) | 기능 추가/개선 | 0.2.0 |
| **Patch** (0.0.X) | 버그 수정, 소규모 패치 | 0.2.1 |

## 9) 빠른 체크리스트
1. `--dry-run`으로 Notion 매핑 확인
2. `--headed --slow=300`으로 ERP 동작 관찰
3. 실패 시 `artifacts/register-otherwork/<timestamp>/` 스크린샷 확인
4. 주간보고는 `artifacts/weekly-report/` 에 요약 텍스트 저장됨
