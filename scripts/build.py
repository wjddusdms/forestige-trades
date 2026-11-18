import json
import re
import shutil
from pathlib import Path

root = Path(__file__).resolve().parents[1]
site = root / "site"
dist = root / "dist"

snapshot = json.loads((site / "data/snapshot.json").read_text(encoding="utf-8"))
status = json.loads((site / "data/status.json").read_text(encoding="utf-8"))
if snapshot["version"] != 1 or status["state"] not in {"pending", "ok", "failed"}:
    raise ValueError("공개 데이터 형식 오류")
if snapshot["updatedAt"] is None and snapshot["buckets"]:
    raise ValueError("정상 갱신 기록 누락")
for bucket in snapshot["buckets"].values():
    if not isinstance(bucket["pending"], int) or bucket["pending"] < 0:
        raise ValueError("검증 대상 건수 오류")
    for row in bucket["trades"]:
        if row["kind"] not in {"sale", "lease", "rent"} or row["complex"] not in {1, 2, 3}:
            raise ValueError("공개 거래 분류 오류")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", row["date"]):
            raise ValueError("공개 거래 계약일 오류")
for relative in ("index.html", "app.js", "model.js", "style.css", "data/snapshot.json", "data/status.json"):
    destination = dist / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(site / relative, destination)
(dist / ".nojekyll").touch()
print("정적 사이트 빌드 완료")
