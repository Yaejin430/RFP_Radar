import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildListUrl,
  dedupeLatest,
  fetchBids,
  formatInqryDt,
  normalizeBid,
  normalizeServiceKey,
  parseG2bResponse,
  toKstIso,
  parseInqryDt,
} from "../public/js/g2b.js";

const RAW = {
  bidNtceNo: "R26BK00000001",
  bidNtceOrd: "000",
  bidNtceNm: "국유재산 활용 전략 연구",
  ntceInsttNm: "기획재정부",
  dminsttNm: "기획재정부",
  bidNtceDt: "2026-09-28 10:00:00",
  bidClseDt: "2026-10-15 10:00:00",
  opengDt: "2026-10-15 11:00:00",
  asignBdgtAmt: "320000000",
  presmptPrce: "290909091",
  cntrctCnclsMthdNm: "제한경쟁",
  sucsfbidMthdNm: "협상에의한계약",
  bidNtceDtlUrl: "https://www.g2b.go.kr/link/R26BK00000001",
  ntceSpecDocUrl1: "https://www.g2b.go.kr/file/1",
  ntceSpecFileNm1: "제안요청서.pdf",
  ntceSpecDocUrl2: "",
  ntceSpecFileNm2: "",
};

test("조회일시는 KST 기준 YYYYMMDDHHMM", () => {
  assert.equal(formatInqryDt(new Date("2026-09-30T15:30:00Z")), "202610010030");
});

test("인코딩된 서비스키는 한 번 디코딩한다", () => {
  assert.equal(normalizeServiceKey("abc%2Bdef%3D%3D"), "abc+def==");
  assert.equal(normalizeServiceKey("abc+def=="), "abc+def==");
});

test("목록 요청 URL 파라미터", () => {
  const url = buildListUrl({
    serviceKey: "k",
    begin: new Date("2026-09-24T00:00:00+09:00"),
    end: new Date("2026-10-01T00:00:00+09:00"),
  });
  assert.equal(url.pathname, "/1230000/ad/BidPublicInfoService/getBidPblancListInfoServc");
  assert.equal(url.searchParams.get("inqryDiv"), "1");
  assert.equal(url.searchParams.get("inqryBgnDt"), "202609240000");
  assert.equal(url.searchParams.get("type"), "json");
});

test("응답 items 는 배열·item 객체·단건 모두 처리한다", () => {
  const wrap = (items) => JSON.stringify({ response: { header: { resultCode: "00" }, body: { items, totalCount: 1 } } });
  assert.equal(parseG2bResponse(wrap([RAW])).items.length, 1);
  assert.equal(parseG2bResponse(wrap({ item: [RAW] })).items.length, 1);
  assert.equal(parseG2bResponse(wrap({ item: RAW })).items.length, 1);
  assert.equal(parseG2bResponse(wrap("")).items.length, 0);
});

test("XML 인증 오류를 읽을 수 있는 메시지로 바꾼다", () => {
  const xml =
    "<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>";
  assert.throws(() => parseG2bResponse(xml), /SERVICE_KEY_IS_NOT_REGISTERED_ERROR/);
});

test("공고 정규화", () => {
  const b = normalizeBid(RAW);
  assert.equal(b.id, "R26BK00000001-000");
  assert.equal(b.budget, 320000000);
  assert.equal(b.closeAt, "2026-10-15T10:00:00+09:00");
  assert.deepEqual(b.attachments, [{ name: "제안요청서.pdf", url: "https://www.g2b.go.kr/file/1" }]);
});

test("정정공고는 최신 차수만 남긴다", () => {
  const a = normalizeBid(RAW);
  const b = normalizeBid({ ...RAW, bidNtceOrd: "001", bidNtceNm: "국유재산 활용 전략 연구(정정)" });
  const out = dedupeLatest([a, b]);
  assert.equal(out.length, 1);
  assert.equal(out[0].ord, "001");
});

test("취소공고는 빼고, 번호가 바뀐 재등록 공고는 최신 것만 남긴다", () => {
  const cancelled = normalizeBid({ ...RAW, bidNtceNo: "C1", bidNtceOrd: "001", ntceKindNm: "취소공고" });
  const older = normalizeBid({ ...RAW, bidNtceNo: "R1", bidNtceDt: "2026-09-20 09:00:00" });
  const newer = normalizeBid({ ...RAW, bidNtceNo: "R2", bidNtceDt: "2026-09-28 09:00:00" });
  const out = dedupeLatest([cancelled, older, newer]);
  assert.equal(out.length, 1);
  assert.equal(out[0].no, "R2");
});

test("조회일시 문자열을 KST 기준 Date로 되돌린다", () => {
  const d = parseInqryDt("202610010930");
  assert.equal(formatInqryDt(d), "202610010930");
  assert.equal(parseInqryDt("bad"), null);
});

test("toKstIso 는 다양한 형식을 받는다", () => {
  assert.equal(toKstIso("202610151000"), "2026-10-15T10:00:00+09:00");
  assert.equal(toKstIso(""), null);
});

test("fetchBids 는 전체 건수만큼 페이지를 넘긴다", async () => {
  const pages = [
    Array.from({ length: 2 }, (_, i) => ({ ...RAW, bidNtceNo: `A${i}`, bidNtceNm: `연구 ${i}` })),
    [{ ...RAW, bidNtceNo: "A9", bidNtceNm: "연구 9" }],
  ];
  const calls = [];
  const fetchImpl = async (url) => {
    const pageNo = Number(new URL(url).searchParams.get("pageNo"));
    calls.push(pageNo);
    const body = { items: pages[pageNo - 1] || [], totalCount: 3 };
    return new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body } }));
  };
  const out = await fetchBids({ serviceKey: "k", numOfRows: 2, fetchImpl });
  assert.deepEqual(calls, [1, 2]);
  assert.equal(out.bids.length, 3);
  assert.equal(out.truncated, false);
});
