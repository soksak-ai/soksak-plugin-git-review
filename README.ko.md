# soksak-plugin-git-review

브랜치·워크트리 변경의 로컬 리뷰. diff 표면, 결정적 레코드 계약으로 저장되는 코멘트,
코멘트를 대상 터미널에 주입하는 명령, 그리고 승인→머지 생명주기. git 은 process capability 로
직접 실행한다 — 다른 플러그인에 의존하지 않는다.

## 명령

- `diff.files` / `diff.read` — 리뷰 데이터: 대상(브랜치·워크트리)의 base 대비 변경 파일(추가/삭제
  카운트 포함)과 unified diff 본문. 뷰가 렌더하는 것과 같은 데이터.
- `comment.add` / `comment.list` / `comment.resolve` / `comment.reopen` — 코멘트 생명주기.
- `comment.send` — 대상의 open 코멘트를 터미널 pane 에 결정적 페이로드로 주입(pane 명시). 리뷰→에이전트
  회귀 경로.
- `approve` — 대상 승인 기록.
- `merge` — 코멘트가 해소된, 승인된 대상을 로컬 머지.

## 코멘트 계약

코멘트는 레코드 `{ id, target, file, line?, body, status, author, createdAt }` — 이 스키마가 하류
소비자(redispatch)가 읽는 계약이다. `status` 는 `open` 또는 `resolved`. `target` 은 리뷰 대상(브랜치·
워크트리)을 지칭한다. `file`/`line` 은 null 일 수 있다(파일 단위 또는 일반 코멘트).

## 뷰

**리뷰** 표면(콘텐츠·사이드바)이 변경 파일과 diff 를, 파일에 고정된 코멘트와 승인 컨트롤과 함께 보여준다.
상태(loading / clean / changed / approved / error)를 뷰 status 축에 보고한다.
