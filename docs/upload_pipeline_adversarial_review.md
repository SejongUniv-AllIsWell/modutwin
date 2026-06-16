# Upload Pipeline Review

5.5와 5.3-codex 모두 콜백 누락, GS 재시도, cleanup 순서를 지적했다. 5.5는 취소 race, 5.3은 outbox/SAM3 race를 더 봤다. 수정: callback fail-fast/완료후 실패 무시, 확정 실패만 삭제, Task+outbox 선커밋, reconciler 재시도, sparse 검증, refined legacy 안전삭제, SOG commit.
