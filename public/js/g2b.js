// 조달청 나라장터 입찰공고정보서비스(공공데이터포털) 클라이언트.
// 용역 입찰공고 목록을 기간 단위로 수집하고, 화면에서 쓰기 좋은 형태로 정규화한다.

export const G2B_BASE = "https://apis.data.go.kr/1230000/ad/BidPublicInfoService";
export const SERVICE_LIST_OP = "getBidPblancListInfoServc";

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export class G2bError extends Error {
  constructor(message, code = "G2B_ERROR") {
    super(message);
    this.name = "G2bError";
    this.code = code;
  }
}

// 공공데이터포털은 "Encoding"·"Decoding" 두 형태의 키를 준다.
// URLSearchParams가 다시 인코딩하므로 Decoding 형태로 맞춘다.
export function normalizeServiceKey(key) {
  const trimmed = String(key || "").trim();
  if (/%[0-9A-F]{2}/i.test(trimmed)) {
    try {
      return decodeURIComponent(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

// Date -> "YYYYMMDDHHMM" (KST)
export function formatInqryDt(date) {
  const k = new Date(date.getTime() + KST_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    k.getUTCFullYear() +
    pad(k.getUTCMonth() + 1) +
    pad(k.getUTCDate()) +
    pad(k.getUTCHours()) +
    pad(k.getUTCMinutes())
  );
}

export function buildListUrl({ serviceKey, begin, end, pageNo = 1, numOfRows = 100, keyword = "" }) {
  const url = new URL(`${G2B_BASE}/${SERVICE_LIST_OP}`);
  url.searchParams.set("ServiceKey", normalizeServiceKey(serviceKey));
  url.searchParams.set("pageNo", String(pageNo));
  url.searchParams.set("numOfRows", String(numOfRows));
  url.searchParams.set("type", "json");
  url.searchParams.set("inqryDiv", "1"); // 1: 공고게시일시 기준
  url.searchParams.set("inqryBgnDt", formatInqryDt(begin));
  url.searchParams.set("inqryEndDt", formatInqryDt(end));
  if (keyword) url.searchParams.set("bidNtceNm", keyword);
  return url;
}

// 인증 오류 등은 type=json 을 줘도 XML로 돌아오는 경우가 있어 둘 다 처리한다.
export function parseG2bResponse(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const msg =
      matchTag(text, "returnAuthMsg") || matchTag(text, "errMsg") || matchTag(text, "resultMsg");
    const code = matchTag(text, "returnReasonCode") || matchTag(text, "resultCode");
    throw new G2bError(
      msg ? `나라장터 API 오류: ${msg}${code ? ` (${code})` : ""}` : "나라장터 API 응답을 해석할 수 없습니다.",
      "G2B_BAD_RESPONSE"
    );
  }

  const header = json?.response?.header;
  if (header && header.resultCode && header.resultCode !== "00") {
    throw new G2bError(`나라장터 API 오류: ${header.resultMsg} (${header.resultCode})`, "G2B_RESULT");
  }

  const body = json?.response?.body ?? {};
  let items = body.items ?? [];
  if (items && !Array.isArray(items)) items = items.item ?? [];
  if (items && !Array.isArray(items)) items = [items];
  return { items: items || [], totalCount: Number(body.totalCount) || 0 };
}

function matchTag(text, tag) {
  const m = String(text).match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1].trim() : "";
}

function toAmount(v) {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// "2026-09-30 10:00:00" 또는 "202609301000" -> ISO 문자열(KST 오프셋 포함)
export function toKstIso(value) {
  if (!value) return null;
  const m = String(value)
    .trim()
    .match(/^(\d{4})-?(\d{2})-?(\d{2})(?:[ T]?(\d{2}):?(\d{2})(?::?(\d{2}))?)?/);
  if (!m) return null;
  const [, y, mo, d, h = "00", mi = "00", s = "00"] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}+09:00`;
}

export function normalizeBid(raw) {
  const attachments = [];
  for (let i = 1; i <= 10; i++) {
    const url = raw[`ntceSpecDocUrl${i}`];
    const name = raw[`ntceSpecFileNm${i}`];
    if (url && name) attachments.push({ name: String(name), url: String(url) });
  }
  const no = String(raw.bidNtceNo ?? "").trim();
  const ord = String(raw.bidNtceOrd ?? "000").trim();
  return {
    id: `${no}-${ord}`,
    no,
    ord,
    title: String(raw.bidNtceNm ?? "").trim(),
    agency: String(raw.ntceInsttNm ?? "").trim(),
    demandAgency: String(raw.dminsttNm ?? "").trim(),
    kind: String(raw.ntceKindNm ?? "").trim(),
    contractMethod: String(raw.cntrctCnclsMthdNm ?? "").trim(),
    awardMethod: String(raw.sucsfbidMthdNm ?? raw.bidMethdNm ?? "").trim(),
    postedAt: toKstIso(raw.bidNtceDt),
    closeAt: toKstIso(raw.bidClseDt),
    openAt: toKstIso(raw.opengDt),
    budget: toAmount(raw.asignBdgtAmt),
    estPrice: toAmount(raw.presmptPrce),
    url: raw.bidNtceDtlUrl || raw.bidNtceUrl || null,
    attachments,
  };
}

// 취소공고는 입찰할 수 없으므로 뺀다. 같은 공고번호의 정정공고(차수)는 최신 차수만,
// 취소 후 재등록처럼 번호가 바뀐 같은 공고(기관·공고명 동일)는 가장 늦게 게시된 것만 남긴다.
export function dedupeLatest(bids) {
  const byNo = new Map();
  for (const b of bids) {
    if (b.kind.includes("취소")) continue;
    const prev = byNo.get(b.no);
    if (!prev || b.ord > prev.ord) byNo.set(b.no, b);
  }
  const byTitle = new Map();
  for (const b of byNo.values()) {
    const key = `${b.agency}|${b.title}`;
    const prev = byTitle.get(key);
    if (!prev || (b.postedAt || "") > (prev.postedAt || "")) byTitle.set(key, b);
  }
  return [...byTitle.values()];
}

export const PAGE_ROWS = 999; // API가 허용하는 한 페이지 최대 건수

// "YYYYMMDDHHMM"(KST) -> Date
export function parseInqryDt(value) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(value || ""));
  return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+09:00`) : null;
}

// 페이지 원문을 가져오는 방법(fetchPage)은 호출하는 쪽이 정한다.
// 브라우저는 /api/bids-page 중계를, 테스트·스크립트는 공공데이터포털을 직접 부른다.
// 첫 페이지로 전체 건수를 확인한 뒤 나머지 페이지는 동시에 요청한다.
export async function collectBids({ fetchPage, numOfRows = PAGE_ROWS, maxPages = 8 }) {
  const first = parseG2bResponse(await fetchPage(1));
  const totalCount = first.totalCount;
  const pages = Math.min(maxPages, Math.ceil(totalCount / numOfRows));
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, pages - 1) }, async (_, i) => parseG2bResponse(await fetchPage(i + 2)))
  );
  const raws = [first, ...rest].flatMap((p) => p.items);
  const bids = dedupeLatest(raws.map(normalizeBid).filter((b) => b.no && b.title));
  return { bids, totalCount, truncated: raws.length < totalCount };
}

export async function fetchBids({
  serviceKey,
  days = 7,
  keyword = "",
  now = new Date(),
  maxPages = 8,
  numOfRows = PAGE_ROWS,
  fetchImpl = fetch,
}) {
  if (!serviceKey) throw new G2bError("G2B_SERVICE_KEY 가 설정되지 않았습니다.", "NO_KEY");
  const end = now;
  const begin = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const fetchPage = async (pageNo) => {
    const url = buildListUrl({ serviceKey, begin, end, pageNo, numOfRows, keyword });
    const res = await fetchImpl(url.toString(), { headers: { Accept: "application/json" } });
    const text = await res.text();
    if (!res.ok && !text) throw new G2bError(`나라장터 API HTTP ${res.status}`, "G2B_HTTP");
    return text;
  };
  const result = await collectBids({ fetchPage, numOfRows, maxPages });
  return { ...result, range: { begin: begin.toISOString(), end: end.toISOString() } };
}
