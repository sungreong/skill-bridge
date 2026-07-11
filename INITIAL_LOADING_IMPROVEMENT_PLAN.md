# VS Code Extension 초기 로딩 개선 계획

## 1. 결론

현재 확장은 `activate()`에서 초기 `refresh()`를 기다리지 않으므로 **확장 활성화 함수 자체가 전체 파일 스캔 때문에 직접 지연되지는 않는다.** 다만 사용자가 Skill Bridge 뷰를 처음 열었을 때 실제 데이터가 보이기까지의 경로에는 파일 수에 비례해 느려질 수 있는 작업이 있다.

우선 확인된 병목 후보는 다음 세 가지다.

1. workspace와 central의 모든 관리 대상 스킬 파일을 재귀 순회한다.
2. 순회에서 얻은 파일 전체를 다시 `stat`하여 watcher fingerprint를 만든다.
3. 초기 표시 직후 별도 분석이 같은 파일을 다시 `stat`하고, 텍스트 파일을 읽고, 양쪽 파일 내용까지 비교한다.

또한 매 refresh마다 `.skillbridge/skill-groups.md`를 내용 변경 여부와 무관하게 다시 쓰므로 불필요한 디스크 I/O와 watcher 이벤트를 유발할 수 있다.

현 상태에서 “실제로 몇 ms가 느리다”는 결론은 내릴 수 없다. 저장소에 refresh 계측과 파일 작업 벤치마크는 있지만, 실제 Extension Host에서 수집한 대표 규모별 cold-start 표본은 없고 현재 요약기는 `fingerprint` 구간도 집계하지 않는다. 따라서 **P0 계측 보정 → P1 중복 I/O 제거 → P2 증분 처리** 순서로 진행한다.

## 2. 조사 범위와 초기 로딩 정의

이 문서에서 초기 로딩은 다음 두 구간으로 나눈다.

- **Activation**: VS Code가 확장을 활성화한 시점부터 명령과 뷰 등록을 마치고 `activate()`가 반환될 때까지
- **First usable view**: 초기 refresh가 끝나 workspace/central 트리에 파일과 그룹이 표시될 때까지

위험 분석은 정적 코드 검토를 기준으로 했다. 성능 수치는 실제 Extension Host 측정 전까지 가설로 취급한다.

## 3. 현재 초기 로딩 흐름

1. `activate()`가 두 TreeView, 상태바, 출력 채널, 진단 컬렉션과 명령/도구 객체를 등록한다.
2. 등록 완료 시간을 `[Activation]` 로그로 남긴다.
3. `void refresh()`로 초기 refresh를 예약하고 `activate()`는 반환한다.
4. refresh가 workspace/central 상태 저장소를 보정한다.
5. 네 종류의 스캔을 병렬 실행한다.
   - workspace 스킬
   - central 스킬
   - workspace instruction
   - central instruction
6. 그룹과 project preset을 읽고 TreeProvider에 반영한다.
7. watcher를 만들고, 현재 파일 전체의 fingerprint를 `stat`으로 수집한다.
8. 첫 화면 표시 완료 로그를 남긴다.
9. 백그라운드 enrichment가 전체 파일 메타데이터, 경고, 링크, 양쪽 변경 여부를 분석하고 진단 UI를 갱신한다.

관련 코드:

- `apps/vscode/src/extension.ts`: 활성화, 전체 명령/도구 등록, 초기 `void refresh()` 호출
- `apps/vscode/src/extensionRefreshRuntime.ts`: refresh 단계, timing 로그, fingerprint, 후속 enrichment
- `apps/vscode/src/skillScanner.ts`: agent별 skill root 탐색과 전체 파일 수집
- `apps/vscode/src/extensionStorage.ts`: 상태 파일 보정, 그룹/프리셋 로딩, instruction 스캔
- `apps/vscode/src/extensionDiagnostics.ts`: 전체 파일 stat/read와 양쪽 내용 비교
- `apps/vscode/src/extensionSupport.ts`: 파일 watcher 생성
- `scripts/summarize-refresh-timings.cjs`: refresh 로그 요약

## 4. 병목 후보와 근거

### P0. 현재 계측이 실제 first usable 비용을 완전히 보여주지 못함

확인된 사실:

- refresh 로그는 `scan`, `inventory+meta`, `groups+chrome`, `watchers`, `fingerprint`를 출력한다.
- `scripts/summarize-refresh-timings.cjs`의 정규식과 단계 목록에는 `fingerprint`가 없다. 결과적으로 전체 파일 `stat` 비용이 성능 요약과 회귀 판정에서 빠진다.
- first visible 경로에서는 `providerMs`를 상수 `0`으로 기록하므로 `providers+diagnostics` 지표가 의미 있는 측정값이 아니다.
- activation 로그는 등록 완료까지만 측정하고, 첫 사용 가능 시점과 연결되는 공통 run ID가 없다.
- 기존 `.benchmarks` 파일 작업 벤치마크는 유용하지만 Extension Host의 실제 활성화/첫 refresh를 직접 재현하지 않는다.

영향:

- 가장 느린 단계가 fingerprint여도 보고서에서 드러나지 않을 수 있다.
- 최적화 전후 비교가 실제 사용자 체감과 어긋날 수 있다.

개선:

- timing parser와 summary stage에 `fingerprint`를 추가한다.
- `activationRegistered`, `firstVisible`, `enrichmentComplete`를 동일한 refresh generation/run ID로 연결한다.
- `stateRepair`, `groupLoad`, `presetLoad`, `providerApply`를 필요할 때 세분화한다.
- 시간뿐 아니라 `filesVisited`, `filesStatted`, `filesRead`, `bytesRead`, `rootsScanned`도 함께 기록한다.
- 실제 VSIX/Extension Host에서 small/medium/large fixture를 각각 cold 5회, warm 10회 측정한다.

완료 조건:

- 성능 요약의 stage 합계가 `[Refresh:visible] completed`와 허용 오차 내에서 일치한다.
- fingerprint 회귀가 CI의 median regression 검사에 포함된다.
- 대표 fixture별 median과 p90 baseline이 문서 또는 artifact로 보존된다.

### P1. refresh마다 그룹 Markdown을 무조건 다시 씀

확인된 사실:

- `ensureSkillBridgeStateForBase()`는 매 호출마다 그룹 JSON을 읽고 `skill-groups.md`를 `writeFile()`로 다시 생성한다.
- 이 작업은 workspace와 central에 병렬로 실행된다.
- 해당 Markdown 경로는 watcher 대상이다.

영향:

- 네트워크 드라이브, 원격 workspace, 백신/인덱서가 개입하는 Windows 환경에서 불필요한 쓰기 비용이 커질 수 있다.
- 파일 내용이 같아도 mtime/ctime과 watcher 이벤트가 바뀌어 후속 변경 판정 비용을 만들 수 있다.
- 읽기 중심이어야 할 refresh가 workspace를 수정한다.

개선:

- 생성할 Markdown과 기존 내용을 비교하여 다를 때만 쓴다.
- 가능하면 상태 마이그레이션/repair와 일반 refresh를 분리한다.
- 자체 생성 파일 이벤트는 generation 또는 최근 write signature로 명시적으로 무시한다.

완료 조건:

- 변경 없는 refresh에서 workspace/central의 그룹 파일 mtime이 바뀌지 않는다.
- 변경 없는 refresh 20회 동안 self-triggered 추가 refresh가 발생하지 않는다.
- 최초 생성과 실제 그룹 변경 시 Markdown 동기화 동작은 유지된다.

### P1. 전체 파일 순회 뒤 동일 파일을 다시 stat함

확인된 사실:

- skill scan은 각 agent의 후보 root를 검사하고, 존재하는 모든 `skills` 디렉터리를 재귀 순회한다.
- 첫 화면을 표시하기 전에 `buildWatchedFileStats()`가 스캔 결과의 모든 스킬/instruction 파일을 다시 `stat`한다.
- 파일 수가 늘수록 두 단계 모두 선형으로 증가한다.

영향:

- 작은 로컬 저장소에서는 문제가 작을 수 있지만, 스킬에 이미지·참고자료·스크립트가 많거나 central이 느린 디스크/원격 파일 시스템에 있으면 첫 화면이 늦어진다.

개선 단계:

1. `collectFiles`가 이미 순회하는 동안 얻을 수 있는 파일 메타데이터를 선택적으로 반환하도록 core API를 확장한다.
2. 초기 fingerprint는 스캔 결과 메타데이터를 재사용하고, 스캔에 포함되지 않는 그룹 파일만 별도 stat한다.
3. API 확대가 부담이면 첫 refresh에서는 fingerprint 생성을 background로 옮기되, fingerprint 준비 전 watcher 이벤트는 안전하게 full refresh로 처리한다.

완료 조건:

- first visible 전 동일 스킬 파일에 대한 `readdir/stat` 중복 횟수가 계측상 제거된다.
- large fixture의 first visible median이 baseline보다 개선되고, 파일 변경 감지는 기존 테스트를 통과한다.

### P1. 초기 enrichment가 전체 파일을 다시 읽고 비교함

확인된 사실:

- enrichment는 first visible 이후 `void`로 실행되어 UI 표시를 직접 막지는 않는다.
- 하지만 모든 스킬 파일을 다시 stat하고, 편집 가능한 텍스트 파일은 읽어서 민감정보/절대경로/Markdown 링크를 검사한다.
- workspace와 central에 같은 스킬이 있으면 파일 크기 확인과 내용 비교도 수행한다.

영향:

- 초기 화면 직후 디스크와 Extension Host에 부하를 주어 트리 확장, 명령 실행 등 첫 상호작용을 느리게 만들 수 있다.
- refresh가 연속 발생하면 generation으로 결과 적용은 막아도 이미 시작한 I/O 자체는 취소되지 않는다.

개선:

- fingerprint 또는 `(path, size, mtime)` 기반 enrichment cache를 둔다.
- 변경된 파일/스킬 폴더만 경고와 diff 상태를 다시 계산한다.
- 새 generation 시작 시 이전 분석에 cooperative cancellation을 전달한다.
- first visible 직후 즉시 실행하는 대신 짧은 idle/debounce 구간을 두고, 사용자가 명령을 실행하면 우선권을 양보한다.
- cache는 메모리부터 시작하고, 지속 cache는 측정상 필요할 때만 검토한다.

완료 조건:

- 변경 없는 두 번째 refresh에서 읽는 파일 수가 0 또는 그룹 메타데이터 최소치에 가깝다.
- refresh 연속 10회에서 완료되지 않은 enrichment 작업 수가 누적되지 않는다.
- 진단 결과와 `changed/same/risk` 상태가 기존 결과와 동일하다.

### P2. 모든 agent와 후보 root를 초기부터 스캔함

확인된 사실:

- 초기 state의 agent 목록에는 구성 가능한 agent들과 `agents`가 모두 들어간다.
- 스캔은 agent당 여러 후보 root의 존재를 확인하고, 존재하는 root의 전체 파일을 수집한다.
- 화면 tab/filter는 스캔 이후 적용되므로 현재 보이지 않는 agent도 초기 비용에 포함된다.

개선 선택지:

- 먼저 계측으로 `rootsScanned`와 agent별 시간을 확인한다.
- 현재 visible agent를 우선 스캔해 먼저 표시하고 나머지는 background에서 합치는 progressive loading을 검토한다.
- 단, 전체 그룹 정합성과 tree count가 모든 agent 데이터에 의존하므로 단순히 숨은 agent 스캔을 생략하지 않는다.

완료 조건:

- progressive loading을 적용한다면 UI가 부분 로딩 상태를 명확히 표시한다.
- 최종 tree/group 결과가 기존 full scan과 동일하다.
- tab 전환 시 누락이나 갑작스러운 group 삭제/저장이 발생하지 않는다.

### P2. 활성화 시 모든 기능 모듈과 도구 객체를 즉시 구성함

확인된 사실:

- `extension.ts`는 많은 command, webview, transfer, diagnostics 모듈을 정적 import하고 활성화 중 관련 factory를 대부분 생성한다.
- 실제 비용은 현재 `[Activation] registered`로 측정할 수 있지만 대표 실측 baseline은 없다.

개선 판단:

- activation median/p90이 예산을 넘을 때만 무거운 webview/진단 기능을 동적 import하거나 command 최초 실행 시 생성한다.
- 단순히 파일이 크다는 이유만으로 lazy loading을 적용하지 않는다. 번들 구조와 오류 경로 복잡도가 늘기 때문이다.

완료 조건:

- activation 실측이 예산 초과임을 먼저 증명한다.
- lazy loading 후 첫 명령 실행 지연까지 함께 측정하고, 총 UX가 악화되지 않는다.

## 5. 구현 순서

### 1단계 — 측정 신뢰도 확보

- `fingerprint`를 refresh summary와 회귀 검사에 포함
- refresh generation/run ID 추가
- 파일 I/O 개수 계측 추가
- 실제 Extension Host용 대표 fixture와 측정 절차 작성
- 변경 전 baseline 저장

### 2단계 — 안전한 중복 I/O 제거

- 그룹 Markdown write-if-changed 적용
- self-generated watcher 이벤트 검증
- scan 메타데이터를 fingerprint에서 재사용
- 기존 refresh/watcher/storage 테스트 보강

### 3단계 — enrichment 증분화

- 메모리 cache key 정의
- 변경된 파일과 counterpart만 재분석
- generation cancellation 추가
- 진단 정확성 회귀 테스트 추가

### 4단계 — 필요 시 progressive/lazy loading

- 1~3단계 후에도 p90 목표를 넘는 경우에만 진행
- visible agent 우선 스캔 또는 기능별 dynamic import를 각각 독립 실험
- 복잡도 대비 체감 개선이 작은 실험은 반영하지 않음

## 6. 성능 예산 제안

실측 baseline을 얻기 전의 임시 목표다. CI 머신 절대 시간만으로 실패시키지 말고, 동일 환경 baseline 대비 회귀율과 함께 사용한다.

| 구간 | 임시 목표 |
| --- | ---: |
| Activation registered | median 100ms 이하, p90 200ms 이하 |
| First usable view — medium fixture | median 500ms 이하, p90 1,000ms 이하 |
| First usable view — large fixture | median 1,500ms 이하, p90 2,500ms 이하 |
| 변경 없는 warm refresh | medium fixture median 250ms 이하 |
| 회귀 허용치 | 주요 stage median +20% 이하 |

Fixture 제안:

| 규모 | agent root | 스킬 폴더 | 총 파일 |
| --- | ---: | ---: | ---: |
| small | 2 | 20 | 약 200 |
| medium | 6 | 200 | 약 2,000 |
| large | 10 | 1,000 | 약 10,000 |

각 fixture는 작은 Markdown만 두지 말고 이미지, script, reference 하위 폴더와 workspace/central 중복 스킬을 섞어 enrichment 비용도 재현한다.

## 7. 검증 계획

필수 자동 검증:

- `npm run typecheck`
- `npm run check:max-lines`
- `npm run check:webviews`
- `npm run check:refresh-timings`
- watcher 변경 감지 및 self-write 방지 테스트
- group Markdown 최초 생성/변경/무변경 테스트
- enrichment cache hit/miss 및 결과 동일성 테스트

필수 수동 검증:

1. Extension Development Host를 완전히 종료 후 다시 열어 cold activation을 수집한다.
2. Skill Bridge 뷰를 열고 tree가 사용 가능해지는 시점을 기록한다.
3. workspace와 central 각각에서 파일 생성/수정/삭제를 수행해 자동 refresh를 확인한다.
4. 그룹 수정 후 JSON과 Markdown이 함께 갱신되는지 확인한다.
5. 변경 없는 상태에서 반복 refresh하여 파일 mtime과 refresh 횟수가 증가하지 않는지 확인한다.
6. remote/WSL 또는 느린 경로가 지원 범위라면 별도 표본을 수집한다.

## 8. 이번 조사에서 하지 않은 것

- 실제 사용자 workspace/central 규모를 가정해 병목 시간을 단정하지 않았다.
- 성능 개선 코드는 아직 변경하지 않았다.
- 자동 Git 동작이나 제품 범위 밖 기능은 제안하지 않았다.
- `codegraph`는 저장소가 145개 파일로 작고 연결된 인덱스 도구가 없어 사용하지 않았으며, 전체 검색은 `rg`와 직접 코드 판독으로 확인했다.

## 9. 권장 첫 작업 묶음

첫 구현 PR은 아래 범위로 제한하는 것이 안전하다.

1. timing summary에 `fingerprint` 추가
2. group Markdown write-if-changed 적용
3. 두 동작의 단위 테스트 추가
4. 대표 fixture에서 변경 전후 refresh 로그 비교

이 묶음은 구조를 크게 바꾸지 않으면서 계측 누락과 명확한 불필요 쓰기를 먼저 제거한다. 이후 scan metadata 재사용과 enrichment cache는 별도 PR로 진행한다.
