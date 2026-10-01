import { buildListUrl, formatInqryDt, parseInqryDt, PAGE_ROWS } from "../../public/js/g2b.js";
import { json, clampInt } from "../../lib/http.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_SECONDS = 900;

// GET /api/bids-page?days=7&end=YYYYMMDDHHMM&page=1
// 인증키만 붙여 공공데이터포털 응답 원문을 그대로 흘려보낸다. 해석은 브라우저가 맡으므로
// 수 MB 응답도 서버 CPU를 거의 쓰지 않는다(Cloudflare 무료 요금제 CPU 한도 대응).
// 같은 기간·페이지 요청은 엣지 캐시에 15분간 두어 일일 호출 한도를 아낀다.
export async function onRequestGet({ request, env, waitUntil }) {
  if (!env.G2B_SERVICE_KEY) {
    return json({ error: "G2B_SERVICE_KEY 가 설정되지 않았습니다.", code: "NO_KEY" }, 503);
  }

  const url = new URL(request.url);
  const days = clampInt(url.searchParams.get("days"), 1, 14, 7);
  const page = clampInt(url.searchParams.get("page"), 1, 20, 1);
  const rows = clampInt(url.searchParams.get("rows"), 10, PAGE_ROWS, PAGE_ROWS);

  // 여러 페이지가 같은 조회 구간을 쓰도록 종료 시각은 브라우저가 정해 보낸다. 비정상 값이면 현재 시각을 쓴다.
  const now = Date.now();
  let end = parseInqryDt(url.searchParams.get("end"));
  if (!end || end.getTime() > now + 60 * 60 * 1000 || end.getTime() < now - 2 * DAY_MS) end = new Date(now);
  const begin = new Date(end.getTime() - days * DAY_MS);

  const cacheKey = new Request(
    `${url.origin}/api/bids-page?days=${days}&end=${formatInqryDt(end)}&page=${page}&rows=${rows}`
  );
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let upstream;
  try {
    upstream = await fetch(buildListUrl({ serviceKey: env.G2B_SERVICE_KEY, begin, end, pageNo: page, numOfRows: rows }), {
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    return json({ error: `나라장터 API에 연결하지 못했습니다. (${err.message})`, code: "G2B_NETWORK" }, 502);
  }

  const type = upstream.headers.get("content-type") || "application/json; charset=utf-8";
  const res = new Response(upstream.body, {
    status: upstream.ok ? 200 : 502,
    headers: { "Content-Type": type, "Cache-Control": `public, max-age=${CACHE_SECONDS}` },
  });
  // 인증 오류는 XML로 오므로 JSON 응답만 캐시한다.
  if (upstream.ok && type.includes("json")) waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
