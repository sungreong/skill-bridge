# Max Lines Rule

이 프로젝트는 새 코드가 한 파일에 과도하게 몰리지 않도록 `1000줄 미만` 규칙을 적용한다.

## 기준

- `1000줄 초과`: CI/로컬 검사 실패
- `900줄 이상 ~ 1000줄 이하`: 경고 출력, 다음 작업에서 우선 분리 검토
- 기존 대형 파일은 `scripts/check-max-lines.cjs`의 legacy allowlist로만 예외 관리

## 운영 원칙

- 새 기능은 큰 파일에 계속 누적하지 말고 처음부터 모듈로 분리한다.
- 공용 타입, 상수, 파일 시스템 헬퍼, git/CLI 연동은 역할별 파일로 나눈다.
- allowlist는 임시 장치다. 줄 수가 내려가면 즉시 목록에서 제거한다.

## 권장 분리 순서

1. 타입과 인터페이스를 `types.ts`로 이동
2. 상수를 `constants.ts`로 이동
3. 재사용 헬퍼를 `shared.ts`로 이동
4. 독립 기능을 `config.ts`, `git.ts`, `skillsCli.ts`처럼 책임별로 이동

## 확인 방법

```bash
npm run check:max-lines
```
