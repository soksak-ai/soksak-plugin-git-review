# soksak-plugin-git-review

브랜치·워크트리 변경의 로컬 리뷰. diff 표면, 결정적 레코드 계약으로 저장되는 코멘트,
코멘트를 대상 터미널에 주입하는 명령, 그리고 승인→머지 생명주기.

git 은 실행하지 않는다. 저장소 판별, 브랜치의 변경(삼점 `base...target`), unified diff, 체크아웃된
HEAD, 머지 — 전부 **`soksak-spec-plugin-git`** 에서 온다. 그 구현체는 **계약으로 찾는다 — 이름으로 찾지
않는다**: 매니페스트가 `consumes: ["soksak-spec-plugin-git"]` 를 선언하고 구현체는 `plugin.implementers`
로 해소하며, 코드에도 매니페스트에도 플러그인 id 는 등장하지 않는다. 활성 구현체가 없으면 loud 하게
거부한다(`NO_GIT_PROVIDER`).

git 을 실행하지 않으므로 **`process` 권한을 갖지 않는다** — 아무것도 스폰할 수 없다. `--upload-pack=…`
를 명령이 아니라 거부로 만드는 ref 화이트리스트도, 이름변경을 올바른 경로로 되돌리는 diff 파싱도
계약의 것이고 거기서 채점된다. 보안 규칙의 사본을 하나 더 들고 있는 것이 곧 잘못된 사본이 배포되는
경로다.

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
