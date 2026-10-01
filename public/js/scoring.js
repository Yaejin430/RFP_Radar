// 공고 적합도 점수(0~100). 규칙 기반이므로 브라우저 안에서만 계산하고 외부로 보내지 않는다.
//
//   역량 적합도 35   분야 키워드 일치 × 분야 가중치(핵심 1.0 / 주력 0.7 / 인접 0.4)
//   유사 실적   20   팀 수행 실적과 공고명의 유사도(실적을 불러온 경우에만)
//   거래 관계   15   해당 발주처와의 과거 수행 건수
//   사업 규모   10   팀 실적의 계약금액 분포 기준
//   계약 방식   10   협상에 의한 계약(제안서 평가) 우대
//   준비 기간   10   입찰 마감까지 남은 기간
//
// 실적을 불러오지 않았으면 유사 실적(20점)을 뺀 80점 만점을 100점으로 환산한다.

import { hasKeyword, normalizeOrg } from "./text.js";
import { similarProjects } from "./team.js";

export { hasKeyword };

export const WEIGHTS = [
  { value: 1, label: "핵심" },
  { value: 0.7, label: "주력" },
  { value: 0.4, label: "인접" },
];

export const MAX = { capability: 35, similarity: 20, relation: 15, scale: 10, method: 10, timing: 10 };

export const DEFAULT_PROFILE = {
  name: "공공 컨설팅 기본 프로필",
  practices: [
    {
      id: "strategy",
      label: "경영전략·계획",
      color: "#3b82f6",
      weight: 1,
      keywords: ["중장기", "경영전략", "전략", "비전", "미래", "경쟁력", "로드맵", "마스터플랜", "발전방안", "기본구상", "기본계획", "종합계획", "사업계획", "신사업", "사업화", "수익구조", "효율화", "운영모델", "경영진단", "경영컨설팅", "혁신", "설립"],
    },
    {
      id: "investment",
      label: "투자·타당성",
      color: "#eab308",
      weight: 1,
      keywords: ["타당성", "예비타당성", "경제성", "사업성", "파급효과", "투자유치", "투자", "민간투자", "기금", "펀드", "PPP", "BTL", "BTO", "리스크", "재구조화"],
    },
    {
      id: "accounting",
      label: "회계·재무",
      color: "#14b8a6",
      weight: 0.7,
      keywords: ["회계", "재무제표", "결산", "재무", "자본구조", "내부감사", "IFRS", "부채", "정산", "예산", "재정"],
    },
    {
      id: "pricing",
      label: "원가·요금 산정",
      color: "#22c55e",
      weight: 0.7,
      keywords: ["산정", "원가", "요금", "사용료", "임대료", "수수료", "보증료", "운임", "단가", "적정성", "가치평가", "자산가치", "과금"],
    },
    {
      id: "organization",
      label: "조직·인사·성과",
      color: "#a855f7",
      weight: 0.7,
      keywords: ["조직진단", "조직", "인력", "정원", "직무", "직급", "인사", "보수체계", "성과연봉", "성과관리", "성과평가", "평가체계", "평가지표", "경영평가", "일자리"],
    },
    {
      id: "infra",
      label: "인프라·부동산",
      color: "#ec4899",
      weight: 0.7,
      keywords: ["항만", "배후단지", "공항", "철도", "도로", "휴게시설", "물류", "역세권", "부동산", "부지", "도시", "재생", "경제자유구역", "산업단지", "토지", "리츠", "주택", "국유재산", "공유재산", "유휴", "복합개발", "혁신도시", "정주여건", "재개발", "재건축", "정비계획"],
    },
    {
      id: "policy",
      label: "정책·제도",
      color: "#06b6d4",
      weight: 0.7,
      keywords: ["정책", "제도개선", "제도 개선", "제도", "법령", "실태조사", "가이드라인", "육성", "활성화", "생태계", "국제협력", "해외진출", "균형발전"],
    },
    {
      id: "digital",
      label: "디지털·정보화",
      color: "#f97316",
      weight: 0.4,
      keywords: ["ISP", "ISMP", "정보화", "정보시스템", "차세대", "디지털", "AI", "인공지능", "데이터", "플랫폼", "클라우드", "스마트", "PI", "자동화", "전산"],
    },
    {
      id: "energy",
      label: "에너지·ESG",
      color: "#84cc16",
      weight: 0.4,
      keywords: ["에너지", "풍력", "발전소", "전력", "수소", "원자력", "방사성", "탄소중립", "온실가스", "배출권", "ESG", "기후", "재생에너지"],
    },
  ],
  // 컨설팅성 과업 신호. 아래의 조건부 제외 키워드를 무효로 만드는 근거로도 쓴다.
  signals: ["연구", "컨설팅", "자문", "수립", "방안", "전략", "진단", "평가", "분석", "조사", "검토", "구상", "산정", "검증", "마스터플랜", "원가", "경제성", "타당성", "정산", "개선"],
  // 항상 제외: 컨설팅으로 볼 수 없는 용역
  hardExclusions: ["청소", "방역", "소독", "급식", "구매", "주거래은행", "법인카드", "인쇄", "실시설계", "감리", "측량", "안전진단", "안전점검", "지반조사", "콜센터", "행사대행", "환경영향평가", "교통영향평가", "경상정비", "철거"],
  // 조건부 제외: 컨설팅성 신호("산정", "전략" 등)가 함께 있으면 제외하지 않는다.
  exclusions: ["경비", "시설관리", "유지관리", "유지보수", "폐기물", "운송", "홍보물", "조경", "차량", "임차", "위탁운영", "운영대행", "구축사업", "봉사단", "휴먼케어", "사방사업", "기본설계", "건축설계"],
  keyAccounts: ["기획재정부", "국토교통부"],
  clients: [],
  budget: { min: 20_000_000, idealMin: 50_000_000, idealMax: 500_000_000, max: 2_000_000_000 },
};

export const OTHER_PRACTICE = { id: "other", label: "기타", color: "#8a94a6", weight: 0, keywords: [] };

const DAY_MS = 24 * 60 * 60 * 1000;
// 유사도 18% 미만은 0점, 45% 이상은 만점. 실제 공고 1,773건 기준으로 18%는 상위 약 25%, 45%는 상위 1% 수준이다.
const SIM_LO = 0.18;
const SIM_HI = 0.45;

export function daysUntil(iso, now = new Date()) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return (t - now.getTime()) / DAY_MS;
}

export function gradeOf(score) {
  if (score >= 75) return "A";
  if (score >= 65) return "B";
  if (score >= 50) return "C";
  return "D";
}

const hitBase = (n) => (n >= 3 ? 27 : n === 2 ? 24 : 18);

// 공고기관·수요기관과 가장 많이 수행한 거래처를 찾는다.
export function findRelation(bid, profile) {
  // 조달청이 대신 발주한 공고는 실제 발주처인 수요기관만 본다.
  const proxy = /조달청/.test(bid.agency || "") && bid.demandAgency && bid.demandAgency !== bid.agency;
  const agencies = (proxy ? [bid.demandAgency] : [bid.agency, bid.demandAgency]).map(normalizeOrg).filter(Boolean);
  let best = null;
  for (const c of profile.clients || []) {
    if (c.name.length < 3) continue;
    if (agencies.some((a) => a.includes(c.name) || (a.length >= 4 && c.name.includes(a)))) {
      if (!best || c.count > best.count) best = c;
    }
  }
  const manual = (profile.keyAccounts || []).find((k) => k && agencies.some((a) => a.includes(normalizeOrg(k))));
  if (manual && (!best || best.count < 10)) return { name: manual, count: best?.count ?? 0, manual: true };
  return best;
}

export function scoreBid(bid, profile = DEFAULT_PROFILE, now = new Date(), historyIndex = null) {
  const title = bid.title || "";
  const reasons = [];
  const signalHits = (profile.signals || []).filter((k) => hasKeyword(title, k));

  const hard = (profile.hardExclusions || []).find((k) => hasKeyword(title, k));
  const soft = (profile.exclusions || []).find((k) => hasKeyword(title, k));
  const exclusion = hard || (soft && signalHits.length === 0 ? soft : null);

  // 1) 역량 적합도
  const practiceHits = (profile.practices || [])
    .map((p) => {
      const hits = p.keywords.filter((k) => hasKeyword(title, k));
      const weight = Number.isFinite(p.weight) ? p.weight : 0.7;
      return { practice: p, hits, value: hits.length ? weight * hitBase(hits.length) : 0 };
    })
    .filter((x) => x.hits.length > 0);
  let capability = 0;
  if (practiceHits.length) {
    capability =
      Math.max(...practiceHits.map((x) => x.value)) + (practiceHits.length > 1 ? 3 : 0) + (signalHits.length ? 5 : 0);
    reasons.push(`역량 매칭: ${practiceHits.map((x) => `${x.practice.label}(${x.hits.join(", ")})`).join(" · ")}`);
  } else if (signalHits.length) {
    capability = 8;
    reasons.push(`컨설팅성 과업 신호: ${signalHits.join(", ")} (분야 키워드는 없음)`);
  } else {
    reasons.push("분야 키워드와 컨설팅성 신호가 모두 없음");
  }
  capability = Math.round(Math.min(MAX.capability, capability));

  // 2) 유사 실적
  const hasHistory = Boolean(historyIndex && historyIndex.size);
  const similar = hasHistory ? similarProjects(title, historyIndex, 3) : [];
  let similarity = 0;
  if (hasHistory) {
    const top = similar[0]?.sim ?? 0;
    similarity = Math.round(MAX.similarity * Math.max(0, Math.min(1, (top - SIM_LO) / (SIM_HI - SIM_LO))));
    reasons.push(
      similar.length && top >= SIM_LO
        ? `유사 실적: "${similar[0].title}"${similar[0].year ? `(${similar[0].year})` : ""} 등, 유사도 ${Math.round(top * 100)}%`
        : "유사 실적: 뚜렷하게 비슷한 과거 과업 없음"
    );
  }

  // 3) 거래 관계
  const relation = findRelation(bid, profile);
  let relationScore = 0;
  if (relation) {
    relationScore = relation.manual || relation.count >= 10 ? 15 : relation.count >= 3 ? 11 : 6;
    reasons.push(
      relation.count
        ? `거래 관계: ${relation.name} 과거 수행 ${relation.count}건`
        : `거래 관계: 핵심 발주처(${relation.name})`
    );
  }

  // 4) 사업 규모
  const amount = bid.budget ?? bid.estPrice;
  const b = profile.budget || DEFAULT_PROFILE.budget;
  let scale;
  if (amount == null) {
    scale = 4;
    reasons.push("사업 규모: 예산 미공개");
  } else if (amount >= b.idealMin && amount <= b.idealMax) {
    scale = 10;
    reasons.push("사업 규모: 주력 수주 구간 안");
  } else if (amount >= b.min && amount <= b.max) {
    scale = 6;
    reasons.push("사업 규모: 수행 경험이 있는 구간");
  } else {
    scale = 0;
    reasons.push("사업 규모: 수행 경험 범위 밖");
  }

  // 5) 계약 방식: 제안서 평가(협상에 의한 계약)가 컨설팅 수주에 유리하다.
  const method = `${bid.awardMethod || ""} ${bid.contractMethod || ""}`;
  let methodScore = 3;
  if (method.includes("협상")) {
    methodScore = 10;
    reasons.push("계약 방식: 협상에 의한 계약(제안서 평가)");
  } else if (method.includes("적격")) {
    methodScore = 4;
    reasons.push("계약 방식: 적격심사");
  } else if (method.includes("수의")) {
    methodScore = 2;
    reasons.push("계약 방식: 수의계약");
  }

  // 6) 준비 기간
  const left = daysUntil(bid.closeAt, now);
  let timing;
  if (left == null) timing = 4;
  else if (left < 0) timing = 0;
  else if (left >= 14) timing = 10;
  else if (left >= 7) timing = 8;
  else if (left >= 4) timing = 4;
  else timing = 1;
  if (left != null) reasons.push(left < 0 ? "준비 기간: 이미 마감" : `준비 기간: 마감까지 ${Math.floor(left)}일`);

  const raw = capability + similarity + relationScore + scale + methodScore + timing;
  const maxRaw = 100 - (hasHistory ? 0 : MAX.similarity);
  let score = Math.round((raw / maxRaw) * 100);
  if (exclusion) {
    score = Math.min(score, 15);
    reasons.unshift(`제외 키워드: ${exclusion}`);
  }

  // 레이더에 표시할 대표 분야는 키워드가 가장 많이 걸린 분야로 정한다(동률이면 가중치 순).
  const primary = [...practiceHits].sort(
    (x, y) => y.hits.length - x.hits.length || (y.practice.weight ?? 0) - (x.practice.weight ?? 0)
  )[0]?.practice;

  return {
    score,
    grade: exclusion ? "X" : gradeOf(score),
    excluded: Boolean(exclusion),
    practices: practiceHits.map((x) => x.practice.id),
    primaryPractice: primary ? primary.id : OTHER_PRACTICE.id,
    breakdown: {
      capability,
      similarity: hasHistory ? similarity : null,
      relation: relationScore,
      scale,
      method: methodScore,
      timing,
    },
    similar: similar.filter((x) => x.sim >= SIM_LO),
    relation,
    daysLeft: left,
    reasons,
  };
}
