# Astryx로 Skill Bridge Webview를 수정할 수 있는가

작성일: 2026-07-09  
대상: Skill Bridge VS Code extension webview

## 결론 요약

`facebook/astryx`는 기술적으로 Skill Bridge의 webview에 사용할 수 있다. 다만 현재 코드 구조에서는 바로 붙이는 라이브러리라기보다, webview 프런트엔드를 React 기반 번들로 재구성할 때 의미가 커지는 디자인 시스템이다.

따라서 내 판단은 **지금 당장 기존 webview를 Astryx로 전면 수정하는 것은 보류**다. 대신 새 대형 webview를 만들거나 `Library Manager`처럼 화면 복잡도가 계속 커지는 영역을 React webview로 분리할 때, 별도 실험 브랜치에서 파일 하나가 아닌 작은 화면 단위로 검증하는 것이 적절하다.

## 확인한 사실

### 현재 Skill Bridge webview 구조

- webview HTML은 React 앱이 아니라 TypeScript 함수가 문자열로 직접 생성한다.
- 스타일은 대부분 `<style>` 안의 CSS 문자열이고, 클라이언트 로직도 `<script nonce="...">`로 삽입된다.
- CSP는 대체로 `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-...'` 형태다.
- 빌드는 `apps/vscode/esbuild.cjs`에서 extension host용 `src/extension.ts` 하나를 CommonJS로 번들링하는 구조다. webview 전용 React/Vite/브라우저 번들 파이프라인은 없다.
- 색상과 폰트는 VS Code webview theme variable인 `--vscode-*`를 직접 사용한다.

대표 근거:

- `apps/vscode/src/libraryManagerView.ts`는 `renderLibraryManagerHtml()`에서 HTML, CSS, script를 하나의 문자열로 반환한다.
- `apps/vscode/src/transferManagerView.ts`도 동일하게 inline CSS와 inline script로 화면을 구성한다.
- `apps/vscode/esbuild.cjs`는 Node extension bundle만 만들고 webview client bundle entry를 따로 두지 않는다.

### Astryx 쪽 확인 사항

- Astryx는 Meta/Facebook의 오픈소스 디자인 시스템이며 현재 Beta로 소개되어 있다.
- 공식 README 기준으로 React와 StyleX 기반이고, 150개 이상의 컴포넌트, theme, dark mode, template, CLI를 제공한다.
- 현재 npm 기준 `@astryxdesign/core` 최신 버전은 `0.1.4`이며 peer dependency로 `react >=19.0.0`, `react-dom >=19.0.0`, `@stylexjs/stylex ^0.18.3`를 요구한다.
- `@astryxdesign/theme-neutral`도 `0.1.4`이고 `lucide-react`를 dependency로 가진다.
- `@astryxdesign/core` npm 패키지의 unpacked size는 약 13.8MB다.
- Astryx 공식 문서는 pre-built CSS import를 지원한다고 설명하지만, 컴포넌트 사용 자체는 React 컴포넌트 import가 기본이다.
- CDN/UMD 사용 경로도 문서화되어 있으나, React와 ReactDOM은 별도로 로드해야 한다.

외부 근거:

- [facebook/astryx README](https://github.com/facebook/astryx)
- [@astryxdesign/core README](https://github.com/facebook/astryx/blob/main/packages/core/README.md)
- [Astryx Core docs](https://astryx.atmeta.com/docs/core)
- [Astryx Theme System docs](https://astryx.atmeta.com/docs/theme)
- [Astryx CLI docs](https://astryx.atmeta.com/docs/cli)
- npm registry 조회: `npm view @astryxdesign/core version license dist.unpackedSize peerDependencies --json`, `npm view @astryxdesign/theme-neutral ...`, `npm view @astryxdesign/cli ...`

## 가능 여부

가능하다. VS Code webview는 HTML, CSS, JavaScript를 렌더링할 수 있고 React 앱도 webview 안에서 실행할 수 있다. VS Code 공식 문서도 webview가 복잡한 UI를 만들 수 있는 격리된 HTML 컨텍스트라고 설명한다.

다만 현재 Skill Bridge에는 아래 작업이 먼저 필요하다.

1. webview 전용 브라우저 번들 entry 추가
2. React 19, ReactDOM 19, Astryx core/theme 설치
3. webview HTML에서 local script/css를 `webview.asWebviewUri()`로 로드하도록 변경
4. CSP를 `webview.cspSource`, nonce, local resource policy에 맞게 재설계
5. VS Code theme variable과 Astryx token/theme 사이의 매핑 전략 결정
6. 기존 `postMessage` 프로토콜을 React state/event 구조로 옮김
7. `npm run typecheck`, `npm run check:max-lines`, webview parsing/visual smoke test 추가

즉, "현재 문자열 HTML에 Astryx 버튼만 몇 개 가져다 쓰는" 수준은 가능성이 낮고 효과도 작다. 실질적인 사용은 "React webview로 화면을 이식하면서 Astryx를 UI 기반으로 삼는" 방식이다.

## 실제 장점

### 1. 컴포넌트 일관성

현재 webview들은 버튼, 탭, 카드, 테이블, 상태 chip, toolbar 스타일을 각 파일에서 직접 정의한다. Astryx를 쓰면 Button, Table, Badge, Tabs류 컴포넌트와 문서화된 props를 중심으로 화면 패턴을 맞출 수 있다.

효과가 큰 후보는 `Library Manager`, `Transfer Manager`, `Transfer Explorer`처럼 필터, 테이블, 상태, 선택, 액션이 반복되는 화면이다.

### 2. 접근성 기본값을 얻을 가능성

Astryx는 accessible component library를 표방하고 있고, overlay, dialog, menu, input류 컴포넌트가 이미 설계되어 있다. 현재처럼 수동 DOM 이벤트와 CSS로 직접 구현하는 방식보다 focus, keyboard interaction, ARIA 누락 가능성을 줄일 수 있다.

단, 이것은 자동 보장이 아니다. VS Code webview 안에서 색상 대비, focus ring, keyboard trap, screen reader 동작은 별도 검증이 필요하다.

### 3. theme와 dark mode 체계

Astryx theme는 CSS custom property 기반이고 pre-built CSS도 제공한다. 장기적으로 Skill Bridge가 자체 design token을 갖고 싶다면, 화면별 CSS 조각보다 관리하기 쉽다.

### 4. AI/문서 친화적 CLI

Astryx CLI는 component docs, templates, theme build, JSON API를 제공한다. 화면을 React 컴포넌트 기반으로 옮긴 뒤에는 새 화면 작성과 리팩터링 지시가 더 예측 가능해질 수 있다.

### 5. 큰 화면 리팩터링의 구조적 계기

현재 webview 파일은 UI, CSS, client script가 문자열 안에서 섞이는 경향이 있다. Astryx 도입을 계기로 webview client를 별도 `src/webview/*` 구조로 분리하면, 유지보수성과 테스트 가능성이 좋아질 수 있다.

## 실제 단점

### 1. React 전환 비용이 먼저 든다

현재 프로젝트는 React가 없다. Astryx의 핵심 가치는 React 컴포넌트에서 나오므로, Astryx 도입은 사실상 React webview 전환과 묶인다. 이는 단순 UI 수정이 아니라 빌드 구조, CSP, asset loading, 테스트 방식까지 바꾸는 작업이다.

### 2. VS Code 네이티브 룩과 충돌 가능성

Skill Bridge webview는 `--vscode-editor-background`, `--vscode-foreground`, `--vscode-button-*` 같은 VS Code theme variable을 직접 사용한다. Astryx theme를 그대로 쓰면 VS Code 사용자가 기대하는 workbench 색상과 어긋날 수 있다.

VS Code 공식 문서도 webview가 강력하지만 VS Code 안에서 이질적으로 느껴지기 쉽다고 경고한다. 이 프로젝트의 사용자는 Git CLI에 익숙하지 않은 일반 사용자이므로, 익숙한 VS Code UI와의 일관성이 중요하다.

### 3. 패키지와 번들 크기 증가

현재 extension은 비교적 단순한 dependency 구성을 가진다. Astryx를 쓰려면 React, ReactDOM, StyleX peer dependency, theme package, 아이콘 관련 dependency가 추가된다. npm 기준 `@astryxdesign/core` 자체 unpacked size도 약 13.8MB라 VSIX 크기와 로딩 비용을 반드시 측정해야 한다.

### 4. Beta/maturity 리스크

Astryx는 현재 Beta이고 npm package도 2026-06-24에 생성된 매우 초기 공개 패키지다. 공개 API, theme 빌드, component behavior, 문서가 빠르게 바뀔 수 있다. Skill Bridge는 사용자의 스킬 파일을 다루는 생산성 도구이므로 UI 기반을 너무 이른 시점에 크게 바꾸면 유지보수 리스크가 생긴다.

### 5. CSP와 runtime style injection 이슈

Astryx theme 문서는 runtime theme가 client에서 style injection을 사용한다고 설명한다. 현재 Skill Bridge CSP는 inline style은 허용하지만 script는 nonce만 허용한다. production에서는 `/built` theme와 CSS 파일을 쓰는 편이 더 적절하지만, 그러려면 webview resource URI와 CSP source를 새로 구성해야 한다.

### 6. 기존 AGENTS.md 규칙과 충돌할 수 있는 지점

AGENTS.md는 webview 레이아웃 안정성, 상태 표시 위치, `isBusy` 처리, 상태바 사용, 1000줄 미만 파일 유지, action label 동기화 등을 요구한다. Astryx 템플릿을 그대로 가져오면 카드형 요약, 넓은 section, 외부 디자인 언어가 기존 규칙과 어긋날 수 있다. 컴포넌트를 쓰더라도 Skill Bridge의 UX 규칙을 우선해야 한다.

## 도입 시나리오 비교

| 시나리오 | 가능성 | 장점 | 단점 | 판단 |
| --- | --- | --- | --- | --- |
| 기존 문자열 HTML에 Astryx CSS/theme만 일부 사용 | 낮음 | 전환 범위가 작다 | React 컴포넌트 장점을 거의 못 얻고 theme 충돌만 생긴다 | 비추천 |
| 특정 webview 하나를 React + Astryx로 재작성 | 중간 | 효과와 비용을 실제 측정 가능 | 빌드/CSP/테스트 기반을 새로 만들어야 한다 | 실험으로 적합 |
| 모든 webview 전면 전환 | 가능하지만 비용 큼 | UI 체계 통합 | 리스크와 회귀 범위가 큼 | 현 시점 비추천 |
| Astryx CLI/docs만 참고하고 현 CSS 구조 개선 | 높음 | dependency 증가 없이 디자인 패턴 참고 가능 | 컴포넌트 재사용 이점은 없음 | 단기 추천 |

## 추천 검증 절차

전면 도입 전에 아래 순서로 작은 spike를 권장한다.

1. 새 branch에서 `Library Manager`가 아닌 작은 webview 하나를 React entry로 분리한다.
2. React 19, ReactDOM 19, `@astryxdesign/core`, `@astryxdesign/theme-neutral`만 설치한다.
3. esbuild에 webview browser bundle entry를 추가한다.
4. CSS는 runtime injection 대신 `@astryxdesign/core/astryx.css`와 theme CSS를 webview resource로 로드한다.
5. CSP는 `default-src 'none'`, `style-src ${webview.cspSource}`, `script-src 'nonce-...'`, 필요한 경우 `font-src`/`img-src`만 최소 추가한다.
6. VS Code theme variable을 Astryx custom theme token에 매핑할 수 있는지 확인한다.
7. VSIX 크기, webview 최초 로딩 시간, theme 전환, keyboard navigation, dark/light contrast를 측정한다.
8. 통과 기준을 만족하면 대형 화면 1개에만 적용하고, 실패하면 Astryx는 참고 자료로만 유지한다.

## 최종 판단

내 판단은 **도입 가능하지만, 현재 제품에는 즉시 적용하지 않는 것이 낫다**이다.

근거는 세 가지다.

첫째, Skill Bridge의 현재 webview는 React가 아니라 문자열 기반 HTML 구조다. Astryx의 장점은 React 컴포넌트, theme provider, CLI/docs ecosystem에서 나오므로 지금 구조에 부분 적용하면 효과보다 연결 비용이 크다.

둘째, Skill Bridge는 VS Code extension이고 사용자도 VS Code 안에서 자연스럽게 동작하는 도구를 기대한다. 현재 CSS가 VS Code theme variable을 직접 쓰는 점은 이 제품에 맞는 선택이다. Astryx theme를 넣을 경우 VS Code workbench와 시각적 일관성을 다시 맞춰야 한다.

셋째, Astryx는 매력적인 시스템이지만 2026년 7월 현재 공개 Beta이자 초기 npm package다. 스킬 파일을 복사, 반영, diff 검토하는 핵심 업무 도구의 UI 기반을 전면 교체하기에는 안정성 검증이 부족하다.

따라서 권장 방향은 다음과 같다.

- 단기: Astryx는 설치하지 말고, CLI/docs/templates에서 컴포넌트 구성 방식만 참고한다.
- 중기: webview 번들 구조를 React로 옮길 계획이 생기면 작은 spike로 Astryx를 검증한다.
- 장기: spike에서 VSIX 크기, CSP, 테마 일관성, 접근성, 로딩 속도가 모두 통과할 때만 대형 webview 하나에 제한적으로 도입한다.

## 참고 링크

- [Astryx GitHub repository](https://github.com/facebook/astryx)
- [Astryx Core README](https://github.com/facebook/astryx/blob/main/packages/core/README.md)
- [Astryx Core docs](https://astryx.atmeta.com/docs/core)
- [Astryx Theme System docs](https://astryx.atmeta.com/docs/theme)
- [Astryx CLI docs](https://astryx.atmeta.com/docs/cli)
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)
- [VS Code Theme Color reference](https://code.visualstudio.com/api/references/theme-color)
