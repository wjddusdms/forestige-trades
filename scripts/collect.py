import argparse
import hashlib
import json
import math
import os
import re
import tempfile
import time
import unicodedata
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlencode
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "site/data"
KST = timezone(timedelta(hours=9))
ENDPOINTS = {"sale": "AptTrade", "rent": "AptRent"}
PAGE_SIZE = 500
MAX_PAGES = 100
MAX_REQUESTS = 900
MAX_BYTES = 8 * 1024 * 1024


class CollectionError(Exception):
    pass


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write(path, data):
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                     delete=False) as output:
        temp = Path(output.name)
        try:
            json.dump(data, output, ensure_ascii=False, separators=(",", ":"))
            output.write("\n")
        except BaseException:
            output.close()
            temp.unlink()
            raise
    try:
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


def normalized(value):
    return "".join(unicodedata.normalize("NFC", value).split())


def integer(value):
    if not re.fullmatch(r"-?(?:\d+|\d{1,3}(?:,\d{3})+)", value):
        raise ValueError("정수 필드 형식 오류")
    return int(value.replace(",", ""))


def month_at(index):
    year, month = divmod(index, 12)
    return f"{year:04}{month + 1:02}"


def month_index(value):
    return int(value[:4]) * 12 + int(value[4:]) - 1


def page_from_xml(payload, page_no):
    root = ET.fromstring(payload)
    if root.tag != "response" or root.findtext("header/resultCode", "").strip() not in {"00", "000"}:
        raise CollectionError("API 결과 코드 오류")
    body = root.find("body")
    if body is None:
        raise CollectionError("API 본문 누락")
    total = integer(body.findtext("totalCount", "").strip())
    if (total < 0 or integer(body.findtext("pageNo", "").strip()) != page_no
            or integer(body.findtext("numOfRows", "").strip()) != PAGE_SIZE):
        raise CollectionError("API 페이지 메타데이터 불일치")
    rows = [{child.tag: (child.text or "").strip() for child in item}
            for item in body.findall("items/item")]
    expected = min(PAGE_SIZE, max(0, total - (page_no - 1) * PAGE_SIZE))
    if len(rows) != expected or total > MAX_PAGES * PAGE_SIZE:
        raise CollectionError("API 페이지 건수 불일치")
    return total, rows


class Molit:
    def __init__(self, key):
        self.key = unquote(key.strip())
        self.requests = 0

    def fetch(self, source, region, month, page_no):
        service = ENDPOINTS[source]
        params = urlencode({"serviceKey": self.key, "LAWD_CD": region, "DEAL_YMD": month,
                            "pageNo": page_no, "numOfRows": PAGE_SIZE})
        url = f"https://apis.data.go.kr/1613000/RTMSDataSvc{service}/getRTMSDataSvc{service}?{params}"
        for attempt in range(3):
            if self.requests >= MAX_REQUESTS:
                raise CollectionError("실행당 API 호출 한도 초과")
            self.requests += 1
            time.sleep(0.25)
            try:
                with urlopen(url, timeout=20) as response:
                    payload = response.read(MAX_BYTES + 1)
                    if len(payload) > MAX_BYTES:
                        raise CollectionError("API 응답 크기 한도 초과")
                    return page_from_xml(payload, page_no)
            except HTTPError as error:
                if error.code not in {429, 500, 502, 503, 504}:
                    raise CollectionError(f"API HTTP {error.code}") from None
            except (URLError, OSError, ET.ParseError):
                pass
            if attempt < 2:
                time.sleep(2 ** (attempt + 1))
        raise CollectionError("API 연결 또는 응답 재시도 실패")

    def partition(self, source, region, month):
        total, rows = self.fetch(source, region, month, 1)
        for page_no in range(2, math.ceil(total / PAGE_SIZE) + 1):
            page_total, page_rows = self.fetch(source, region, month, page_no)
            if page_total != total:
                raise CollectionError("페이지 조회 중 거래 건수 변경")
            rows.extend(page_rows)
        return rows


def classify(row, source, region, config):
    name = normalized(row["aptNm"])
    if row["sggCd"] != region or not name or not row["umdNm"]:
        raise CollectionError("응답의 지역 또는 아파트 필드 불일치")
    address = [rule for rule in config["rules"] if (
        rule["region"], rule["dong"], rule["lot"]
    ) == (region, row["umdNm"], row["jibun"])]
    matches = [rule for rule in address if name in rule["verifiedFor"].get(source, [])]
    if len(matches) == 1:
        return matches[0]["complex"], False
    return None, bool(address or "래미안포레스티지" in name)


def convert(row, source, region, month, config):
    complex_id, review = classify(row, source, region, config)
    if complex_id is None and not review:
        return None, None
    day = datetime(*(integer(row[f"deal{part}"]) for part in ("Year", "Month", "Day"))).date()
    if day.strftime("%Y%m") != month:
        raise CollectionError("계약일과 조회월 불일치")
    area = row["excluUseAr"]
    if not re.fullmatch(r"\d+(?:\.\d+)?", area) or not 0 < float(area) < 1000:
        raise CollectionError("전용면적 형식 오류")
    if source == "sale":
        cancel_type = row.get("cdealType", "")
        cancel_date = row.get("cdealDay", "")
        if cancel_type not in {"", "O", "○", "-", "해제"}:
            raise CollectionError("해제여부 필드 형식 오류")
        if cancel_date in {"", "-"}:
            cancel_date = None
        else:
            cancel_date = cancel_date.replace(".", "-")
            if re.fullmatch(r"\d{2}-\d{2}-\d{2}", cancel_date):
                cancel_date = "20" + cancel_date
            if re.fullmatch(r"\d{8}", cancel_date):
                cancel_date = f"{cancel_date[:4]}-{cancel_date[4:6]}-{cancel_date[6:]}"
            cancel_date = datetime.strptime(cancel_date, "%Y-%m-%d").date().isoformat()
        cancelled = bool(cancel_date or cancel_type in {"O", "○", "해제"})
        fields = {"kind": "sale", "amount": integer(row["dealAmount"]), "monthly": 0,
                  "cancelled": cancelled, "cancelDate": cancel_date,
                  "method": row.get("dealingGbn", "")}
    else:
        monthly = integer(row["monthlyRent"])
        fields = {"kind": "rent" if monthly else "lease", "amount": integer(row["deposit"]),
                  "monthly": monthly, "cancelled": False, "cancelDate": None, "method": ""}
    if fields["amount"] < 0 or fields["monthly"] < 0 or (not fields["monthly"] and not fields["amount"]):
        raise CollectionError("거래금액 범위 오류")
    floor = row.get("floor", "")
    trade = dict(fields, date=day.isoformat(), complex=complex_id, area=area,
                 floor=integer(floor) if floor not in {"", "-"} else None)
    if review:
        return None, dict(trade, source=source, region=region, dong=row["umdNm"],
                          lot=row["jibun"], name=row["aptNm"], aptSeq=row.get("aptSeq", ""))
    return trade, None


def run(client, config, previous, now, force_full=False):
    through = now.strftime("%Y%m")
    first = month_index(config["startMonth"])
    last = month_index(through)
    full_at = previous["fullAt"]
    mapping = hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()
    full = (force_full or not full_at or previous["fromMonth"] != config["startMonth"]
            or previous.get("mapping") != mapping
            or now - datetime.fromisoformat(full_at) >= timedelta(days=7))
    start = first if full else max(first, min(last - 3, month_index(previous["throughMonth"])))
    if start > last:
        raise CollectionError("수집 시작월 오류")
    buckets = {} if full else dict(previous["buckets"])
    review_rows = []
    for index in range(start, last + 1):
        month = month_at(index)
        for region in config["regions"]:
            for source in ENDPOINTS:
                trades, pending = [], 0
                for row in client.partition(source, region, month):
                    trade, review = convert(row, source, region, month, config)
                    if trade is not None:
                        trades.append(trade)
                    if review is not None:
                        review_rows.append(review)
                        pending += 1
                # Each query key replaces its complete previous partition. Keep row multiplicity.
                buckets[f"{month}/{region}/{source}"] = {"trades": trades, "pending": pending}
    return {"version": 1, "updatedAt": now.isoformat(), "fromMonth": config["startMonth"],
            "throughMonth": through, "fullAt": now.isoformat() if full else full_at,
            "mapping": mapping, "buckets": buckets}, review_rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--full", action="store_true")
    args = parser.parse_args()
    now = datetime.now(KST).replace(microsecond=0)
    status = {"attemptAt": now.isoformat(), "state": "failed"}
    try:
        key = os.environ.get("MOLIT_API_KEY", "").strip()
        if not key:
            raise CollectionError("MOLIT_API_KEY 미설정")
        config = read(ROOT / "config/complexes.json")
        previous = read(DATA / "snapshot.json")
        snapshot, review = run(Molit(key), config, previous, now, args.full)
        write(ROOT / "review.json", review)
        write(DATA / "snapshot.json", snapshot)
        status["state"] = "ok"
        print(f"갱신 완료. 검증 대상 {len(review)}건 (이번 조회 범위).")
    except CollectionError as error:
        print(f"수집 실패: {error}")
    except Exception as error:
        # Never print request URLs, upstream messages, or exceptions containing the key.
        print(f"수집 실패: {type(error).__name__}")
    write(DATA / "status.json", status)
    return int(status["state"] != "ok")


if __name__ == "__main__":
    raise SystemExit(main())
