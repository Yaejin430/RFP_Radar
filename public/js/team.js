// 팀 수행 실적으로 평가 기준을 만드는 모듈.
// 실적 파일은 브라우저 안에서만 읽고, 결과는 브라우저 저장소에만 남긴다(서버·AI로 보내지 않음).

import { hasKeyword, normalizeOrg } from "./text.js";

const STOP = new Set([
  "용역", "연구", "연구용역", "수립", "수립용역", "방안", "사업", "업무", "지원", "자문", "자문용역", "컨설팅",
  "위한", "관련", "대한", "관한", "통한", "따른", "개선", "개선방안", "검토", "검토용역", "년도", "회계연도",
  "용역업무", "위탁용역", "추진", "마련", "및", "등", "the", "of", "and", "for",
]);

// 공고명 토큰: 단어 + (3글자 이상 한글 단어의) 두 글자 조각. 띄어쓰기 차이("중장기경영전략"/"중장기 경영전략")를 흡수한다.
export function tokenize(title) {
  const words = String(title || "")
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]+/g, " ")
    .split(" ")
    .map((w) => w.replace(/(으로|을|를|의|에|과|와|로)$/, ""))
    .filter((w) => w.length >= 2 && !STOP.has(w) && !/^\d+$/.test(w) && !/^\d+(년|년도|차)$/.test(w));
  const out = new Set(words);
  for (const w of words) {
    if (w.length >= 3 && /[가-힣]/.test(w)) {
      for (let i = 0; i < w.length - 1; i++) out.add(`§${w.slice(i, i + 2)}`);
    }
  }
  return out;
}

// IDF 가중 코사인 유사도를 빠르게 계산하기 위한 역색인
export function buildHistoryIndex(records) {
  const docs = records
    .filter((r) => r && r.title)
    .map((r) => ({ title: r.title, client: r.client || "", year: r.year || "", tokens: tokenize(r.title) }));
  const df = new Map();
  for (const d of docs) for (const t of d.tokens) df.set(t, (df.get(t) || 0) + 1);
  const n = docs.length;
  const idf = (t) => Math.log((n + 1) / ((df.get(t) || 0) + 1)) + 1;
  const postings = new Map();
  docs.forEach((d, i) => {
    let norm = 0;
    for (const t of d.tokens) {
      norm += idf(t) ** 2;
      if (!postings.has(t)) postings.set(t, []);
      postings.get(t).push(i);
    }
    d.norm = Math.sqrt(norm) || 1;
  });
  return { docs, idf, postings, size: n };
}

export function similarProjects(title, index, k = 3) {
  if (!index || !index.size) return [];
  const q = tokenize(title);
  let qnorm = 0;
  const dot = new Map();
  for (const t of q) {
    const w = index.idf(t) ** 2;
    qnorm += w;
    for (const i of index.postings.get(t) || []) dot.set(i, (dot.get(i) || 0) + w);
  }
  qnorm = Math.sqrt(qnorm) || 1;
  return [...dot]
    .map(([i, v]) => ({ ...index.docs[i], sim: v / (qnorm * index.docs[i].norm) }))
    .filter((x) => x.title !== title) // 같은 과업(자기 자신)은 근거에서 뺀다
    .sort((a, b) => b.sim - a.sim)
    .slice(0, k)
    .map(({ title: t, client, year, sim }) => ({ title: t, client, year, sim }));
}

/* ------------------------------------------------------------------ */
/* 실적 파일 해석                                                       */
/* ------------------------------------------------------------------ */

const HEADER = {
  title: ["적요", "과업명", "사업명", "프로젝트명", "용역명", "프로젝트", "과제명"],
  client: ["거래처", "발주처", "발주기관", "고객", "고객사", "수요기관"],
  date: ["등록월", "계약일", "시작일", "착수일", "연도", "계약연도"],
  amount: ["계약금액", "금액", "수주금액", "용역금액"],
};

// 2차원 배열(시트)을 실적 레코드로 바꾼다. 머리글이 첫 줄이 아니어도 앞 20줄에서 찾는다.
export function rowsToRecords(rows) {
  let headerRow = -1;
  let cols = null;
  for (let r = 0; r < Math.min(20, rows.length); r++) {
    const cells = (rows[r] || []).map((c) => String(c ?? "").trim());
    const find = (names) => cells.findIndex((c) => names.includes(c));
    const title = find(HEADER.title);
    if (title >= 0) {
      headerRow = r;
      cols = { title, client: find(HEADER.client), date: find(HEADER.date), amount: find(HEADER.amount) };
      break;
    }
  }
  if (!cols) throw new Error("과업명 열(적요·과업명·사업명 등)을 찾지 못했습니다.");

  const records = [];
  for (const row of rows.slice(headerRow + 1)) {
    const title = String(row?.[cols.title] ?? "").trim();
    if (!title) continue;
    const rawDate = cols.date >= 0 ? row[cols.date] : "";
    const year = parseYear(rawDate);
    const amount = cols.amount >= 0 ? Number(String(row[cols.amount] ?? "").replace(/[^0-9.]/g, "")) || null : null;
    records.push({ title, client: cols.client >= 0 ? String(row[cols.client] ?? "").trim() : "", year, amount });
  }
  return records;
}

function parseYear(v) {
  if (v instanceof Date) return String(v.getFullYear());
  const m = String(v ?? "").match(/(19|20)\d{2}/);
  return m ? m[0] : "";
}

/* ------------------------------------------------------------------ */
/* 실적 기반 프로필 생성                                                 */
/* ------------------------------------------------------------------ */

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
const roundTo = (v, unit, mode) => Math[mode](v / unit) * unit;

export function buildTeamProfile(records, baseProfile) {
  const now = new Date().getFullYear();

  // 1) 거래 관계: 거래처별 수행 건수
  //    회계법인·컨설팅사 명의(법인 간 협업 과업)는 발주처가 아니므로 거래처 집계에서만 뺀다(유사 실적에는 포함).
  const counts = new Map();
  for (const r of records) {
    const key = normalizeOrg(r.client);
    if (key.length < 2 || /(회계법인|컨설팅)$/.test(key)) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const clients = [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

  // 2) 사업 규모: 최근 5년 계약금액 분포(없으면 전체)
  const recent = records.filter((r) => r.amount && r.year && Number(r.year) >= now - 5).map((r) => r.amount);
  const amounts = (recent.length >= 30 ? recent : records.map((r) => r.amount).filter(Boolean)).sort((a, b) => a - b);
  const budget = amounts.length
    ? {
        min: roundTo(pct(amounts, 0.1), 1e7, "floor"),
        idealMin: roundTo(pct(amounts, 0.4), 1e7, "floor"),
        idealMax: roundTo(pct(amounts, 0.9), 1e7, "ceil"),
        max: roundTo(amounts[amounts.length - 1], 1e7, "ceil"),
      }
    : baseProfile.budget;

  // 3) 분야 가중치: 실적에서 차지하는 비중으로 핵심·주력·인접을 정한다.
  const shares = baseProfile.practices.map((p) => ({
    id: p.id,
    share: records.filter((r) => p.keywords.some((k) => hasKeyword(r.title, k))).length / (records.length || 1),
  }));
  const maxShare = Math.max(...shares.map((s) => s.share), 0.0001);
  const practices = baseProfile.practices.map((p) => {
    const share = shares.find((s) => s.id === p.id).share;
    // 가장 큰 분야 비중의 50% 이상이면 핵심, 20% 이상이면 주력, 그 밖은 인접
    const weight = share >= maxShare * 0.5 ? 1 : share >= maxShare * 0.2 ? 0.7 : 0.4;
    return { ...p, weight, share: Math.round(share * 1000) / 10 };
  });

  const years = records.map((r) => Number(r.year)).filter(Boolean);
  return {
    profile: {
      ...baseProfile,
      name: "팀 수행 실적 기반 프로필",
      practices,
      clients,
      budget,
    },
    history: records.map((r) => ({ title: r.title, client: r.client, year: r.year })),
    summary: {
      records: records.length,
      clients: clients.length,
      repeatClients: clients.filter((c) => c.count >= 3).length,
      from: years.length ? Math.min(...years) : null,
      to: years.length ? Math.max(...years) : null,
      budget,
    },
  };
}
