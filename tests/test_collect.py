import copy
import tempfile
import unittest
import sys
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from scripts import collect as c


def api_row(**overrides):
    return dict({"aptNm": "래미안포레스티지1단지", "sggCd": "26260", "umdNm": "온천동",
                 "jibun": "1861", "dealYear": "2026", "dealMonth": "11", "dealDay": "4",
                 "excluUseAr": "84.9849", "floor": "8", "cdealType": "", "cdealDay": "",
                 "dealAmount": "82,500", "deposit": "40,000", "monthlyRent": "0"}, **overrides)


class CollectorTest(unittest.TestCase):
    def setUp(self):
        self.config = c.read(c.ROOT / "config/complexes.json")
        self.config["startMonth"] = "202611"
        self.config["rules"][0]["verifiedFor"] = {
            "sale": ["래미안포레스티지1단지"], "rent": ["래미안포레스티지1단지"]}
        self.now = datetime(2026, 11, 18, tzinfo=c.KST)
        self.previous = {"updatedAt": None, "fullAt": None, "fromMonth": None, "buckets": {}}

    def test_exact_match_and_quarantine(self):
        self.assertEqual(c.classify(api_row(), "sale", "26260", self.config), (1, False))
        for row in [api_row(jibun="1999"), api_row(aptNm="래미안포레스티지상가"),
                    api_row(umdNm="사직동"), api_row(aptNm="래미안포레스티지")]:
            self.assertEqual(c.classify(row, "sale", "26260", self.config), (None, True))
        self.assertEqual(c.classify(api_row(aptNm="다른아파트", jibun="1999"),
                                    "sale", "26260", self.config), (None, False))

    def test_cancellation_and_rental_contracts(self):
        row = api_row(cdealDay="26.11.06", cdealType="O")
        trade, _ = c.convert(row, "sale", "26260", "202611", self.config)
        self.assertEqual((trade["cancelled"], trade["cancelDate"]), (True, "2026-11-06"))
        for monthly, kind in [("0", "lease"), ("112", "rent")]:
            trade, _ = c.convert(api_row(monthlyRent=monthly), "rent", "26260", "202611", self.config)
            self.assertEqual((trade["kind"], trade["amount"], trade["monthly"]), (kind, 40000, int(monthly)))

    def test_duplicate_multiplicity_and_partition_replacement(self):
        class Feed:
            count = 2

            def partition(self, source, region, month):
                return [api_row()] * self.count if (source, region) == ("sale", "26260") else []

        feed = Feed()
        result, _ = c.run(feed, self.config, self.previous, self.now)
        self.assertEqual(len(result["buckets"]["202611/26260/sale"]["trades"]), 2)
        feed.count = 1
        second, _ = c.run(feed, self.config, result, self.now)
        self.assertEqual(len(second["buckets"]["202611/26260/sale"]["trades"]), 1)
        self.assertEqual(len(result["buckets"]["202611/26260/sale"]["trades"]), 2)

    def test_xml_error_is_not_empty(self):
        success = b"<response><header><resultCode>000</resultCode></header><body><totalCount>0</totalCount><pageNo>1</pageNo><numOfRows>500</numOfRows><items/></body></response>"
        self.assertEqual(c.page_from_xml(success, 1), (0, []))
        for body in (success.replace(b"000", b"030"), success.replace(b">0<", b">1<"),
                     b"<OpenAPI_ServiceResponse/>"):
            with self.assertRaises(c.CollectionError):
                c.page_from_xml(body, 1)

    def test_partial_update_preserves_snapshot_on_disk(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / "site/data"
            data.mkdir(parents=True)
            (root / "config").mkdir()
            c.write(root / "config/complexes.json", self.config)
            snapshot = data / "snapshot.json"
            c.write(snapshot, copy.deepcopy(self.previous))
            baseline = snapshot.read_bytes()
            with patch.object(c, "ROOT", root), patch.object(c, "DATA", data), \
                 patch.object(c.Molit, "partition", side_effect=[[], c.CollectionError("API 오류")]), \
                 patch.dict(c.os.environ, {"MOLIT_API_KEY": "fixture-only"}), \
                 patch.object(sys, "argv", ["collect"]):
                self.assertEqual(c.main(), 1)
            self.assertEqual(snapshot.read_bytes(), baseline)
            self.assertEqual(c.read(data / "status.json")["state"], "failed")
