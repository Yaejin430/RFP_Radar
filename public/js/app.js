import { DEFAULT_PROFILE, OTHER_PRACTICE, WEIGHTS, MAX, scoreBid } from "./scoring.js";
import { buildTeamProfile, buildHistoryIndex, rowsToRecords } from "./team.js";
import { collectBids, formatInqryDt } from "./g2b.js";
import { formatKRW, formatDateTime, dDayLabel, escapeHtml as h } from "./format.js";
import { buildDraftAnalysis } from "./draft.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const PROFILE_VERSION = 2;

const KEYS = {
  profile: "rfp-radar:profile",
  pipeline: "rfp-radar:pipeline",
  analyses: "rfp-radar:analyses",
  access: "rfp-radar:access",
  theme: "rfp-radar:theme",
  history: "rfp-radar:history",
  teamSummary: "rfp-radar:team-summary",
};

const STAGES = [
  { id: "watch", label: "관심" },
  { id: "review", label: "검토 중" },
  { id: "prepare", label: "제안 준비" },
  { id: "submitted", label: "제출 완료" },
  { id: "won", label: "수주" },
  { id: "closed", label: "미수주·포기" },
];

const BREAKDOWN = [
  ["capability", "역량 적합도", MAX.capability],
  ["similarity", "유사 실적", MAX.similarity],
  ["relation", "거래 관계", MAX.relation],
  ["scale", "사업 규모", MAX.scale],
  ["method", "계약 방식", MAX.method],
  ["timing", "준비 기간", MAX.timing],
];

const DECISION_LABEL = { GO: "참여 권고", CONDITIONAL: "조건부 참여", NO_GO: "참여 보류" };

// localStorage 는 사생활 보호 모드 등에서 막힐 수 있으므로 실패해도 화면은 동작하게 한다.
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* 저장 불가 환경 */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* 저장 불가 환경 */
    }
  },
};

const clone = (o) => JSON.parse(JSON.stringify(o));

// 분야 체계가 바뀐 이전 버전 프로필은 버리고 기본 프로필로 시작한다.
function loadProfile() {
  const saved = store.get(KEYS.profile, null);
  if (!saved || saved.version !== PROFILE_VERSION || !Array.isArray(saved.practices)) {
    return { ...clone(DEFAULT_PROFILE), version: PROFILE_VERSION };
  }
  return {
    ...clone(DEFAULT_PROFILE),
    ...saved,
    budget: { ...DEFAULT_PROFILE.budget, ...(saved.budget || {}) },
  };
}

function loadHistoryIndex() {
  const history = store.get(KEYS.history, null);
  return Array.isArray(history) && history.length ? buildHistoryIndex(history) : null;
}

const state = {
  bids: [],
  scored: [],
  source: null,
  notice: "",
  error: "",
  health: { g2b: false, ai: false, accessCodeRequired: false },
  days: 7,
  query: "",
  grade: "ALL",
  practice: null,
  showExcluded: false,
  profile: loadProfile(),
  historyIndex: loadHistoryIndex(),
  teamSummary: store.get(KEYS.teamSummary, null),
  pipeline: store.get(KEYS.pipeline, {}),
  analyses: store.get(KEYS.analyses, {}),
  fetchedAt: null,
  truncated: false,
  now: new Date(),
  selectedId: null,
  lastFocus: null,
};

const $ = (sel, root = document) => root.querySelector(sel);

/* ------------------------------------------------------------------ */
/* 데이터                                                              */
/* ------------------------------------------------------------------ */

async function checkHealth() {
  try {
    const res = await fetch("api/health", { headers: { Accept: "application/json" } });
    if (res.ok) state.health = { ...state.health, ...(await res.json()) };
  } catch {
    /* 정적 호스팅(로컬 미리보기 등): API 없음 */
  }
}

async function loadBids() {
  const forceDemo = new URLSearchParams(location.search).has("demo");
  state.error = "";
  setBusy(true);
  if (!state.bids.length) {
    const msg = `<div class="loading" style="justify-content:center;padding:40px 0"><span class="spinner"></span>나라장터에서 최근 ${state.days}일 용역 공고를 수집하고 있습니다. 처음 수집할 때는 10~20초 정도 걸리고, 이후 15분 동안은 바로 열립니다.</div>`;
    $("#radar").innerHTML = msg.replace("loading", "loading radar-loading");
    $("#bid-list").innerHTML = msg;
  }
  try {
    if (state.health.g2b && !forceDemo) {
      // 모든 페이지가 같은 조회 구간을 쓰도록 종료 시각을 10분 단위로 고정한다(엣지 캐시 적중률도 높아진다).
      const end = formatInqryDt(new Date(Math.floor(Date.now() / 600000) * 600000));
      const fetchPage = async (page) => {
        const res = await fetch(`api/bids-page?days=${state.days}&end=${end}&page=${page}`);
        const text = await res.text();
        if (!res.ok) {
          let message = `HTTP ${res.status}`;
          try {
            message = JSON.parse(text).error || message;
          } catch {
            /* 원문이 JSON이 아님 */
          }
          throw new Error(message);
        }
        return text;
      };
      const data = await collectBids({ fetchPage });
      state.bids = data.bids;
      state.source = "g2b";
      state.fetchedAt = new Date().toISOString();
      state.truncated = data.truncated;
    } else {
      await loadDemo();
    }
  } catch (err) {
    state.error = `나라장터 수집에 실패해 데모 데이터로 전환했습니다. (${err.message})`;
    await loadDemo();
  } finally {
    setBusy(false);
  }
  rescore();
  render();
}

async function loadDemo() {
  const res = await fetch("data/demo-bids.json");
  const data = await res.json();
  const now = state.now.getTime();
  const atHour = (t, hour) => {
    const d = new Date(t);
    d.setMinutes(0, 0, 0);
    d.setHours(hour);
    return d.toISOString();
  };
  state.bids = data.bids.map((b) => {
    const closeAt = atHour(now + b.closeInDays * DAY_MS, 10);
    return {
      id: `${b.no}-000`,
      no: b.no,
      ord: "000",
      title: b.title,
      agency: b.agency,
      demandAgency: b.demandAgency,
      kind: "일반",
      contractMethod: b.contractMethod,
      awardMethod: b.awardMethod,
      postedAt: atHour(now - b.postedDaysAgo * DAY_MS, 9),
      closeAt,
      openAt: new Date(new Date(closeAt).getTime() + 60 * 60 * 1000).toISOString(),
      budget: b.budget,
      estPrice: b.budget ? Math.round(b.budget / 1.1) : null,
      url: null,
      attachments: (b.attachments || []).map((name) => ({ name, url: null })),
    };
  });
  state.source = "demo";
  state.notice = data.notice;
  state.fetchedAt = new Date().toISOString();
  state.truncated = false;
}

function rescore() {
  state.now = new Date();
  state.scored = state.bids
    .map((bid) => ({ bid, s: scoreBid(bid, state.profile, state.now, state.historyIndex) }))
    .sort((a, b) => b.s.score - a.s.score || (a.s.daysLeft ?? 99) - (b.s.daysLeft ?? 99));
}

function practiceList() {
  return [...state.profile.practices, OTHER_PRACTICE];
}

function practiceById(id) {
  return practiceList().find((p) => p.id === id) || OTHER_PRACTICE;
}

function visible() {
  const q = state.query.trim();
  return state.scored.filter(({ bid, s }) => {
    if (s.excluded && !state.showExcluded) return false;
    if (state.grade !== "ALL" && s.grade !== state.grade) return false;
    if (state.practice && s.primaryPractice !== state.practice && !s.practices.includes(state.practice)) return false;
    if (q && !`${bid.title} ${bid.agency} ${bid.demandAgency}`.includes(q)) return false;
    return true;
  });
}

const isFit = (x) => !x.s.excluded && (x.s.grade === "A" || x.s.grade === "B");

/* ------------------------------------------------------------------ */
/* 렌더링                                                              */
/* ------------------------------------------------------------------ */

function render() {
  renderBanner();
  renderKpis();
  const rows = visible();
  renderRadar(rows);
  renderDeadlines();
  renderPracticeBars();
  renderChips();
  renderList(rows);
  renderPipelineCount();
  if (!$("#tab-pipeline").hidden) renderBoard();
}

function renderBanner() {
  const el = $("#banner");
  const parts = [];
  if (state.error) parts.push(h(state.error));
  if (state.source === "demo") {
    parts.push(
      `<strong>데모 모드</strong>입니다. ${h(state.notice)} 실제 공고를 보려면 서버에 <code>G2B_SERVICE_KEY</code>를 설정하십시오.`
    );
  }
  if (state.truncated) parts.push("공고가 많아 일부만 수집했습니다. 조회 기간을 줄이면 전체를 볼 수 있습니다.");
  el.innerHTML = parts.join("<br />");
  el.hidden = parts.length === 0;
}

function renderKpis() {
  const fit = state.scored.filter(isFit);
  const a = fit.filter((x) => x.s.grade === "A").length;
  const budget = fit.reduce((sum, x) => sum + (x.bid.budget ?? x.bid.estPrice ?? 0), 0);
  const soon = fit.filter((x) => x.s.daysLeft != null && x.s.daysLeft >= 0 && x.s.daysLeft <= 7).length;
  const excluded = state.scored.filter((x) => x.s.excluded).length;

  const tiles = [
    {
      label: "수집 공고",
      value: `${state.scored.length}<small>건</small>`,
      sub: `${state.source === "demo" ? "데모 데이터" : `최근 ${state.days}일 용역 공고`} · 제외 ${excluded}건`,
    },
    { label: "적합 기회 (A·B등급)", value: `${fit.length}<small>건</small>`, sub: `A등급 ${a}건` },
    { label: "적합 기회 예산 합계", value: h(formatKRW(budget || null)), sub: "배정예산 기준, 미공개 제외", small: true },
    { label: "7일 안에 마감", value: `${soon}<small>건</small>`, sub: "적합 기회 가운데 우선 검토 대상" },
  ];
  $("#kpis").innerHTML = tiles
    .map(
      (t) => `<div class="kpi"><div class="label">${t.label}</div>
      <div class="value"${t.small ? ' style="font-size:21px"' : ""}>${t.value}</div>
      <div class="sub">${t.sub}</div></div>`
    )
    .join("");
}

function hash01(str) {
  let x = 2166136261;
  for (let i = 0; i < str.length; i++) {
    x ^= str.charCodeAt(i);
    x = Math.imul(x, 16777619);
  }
  return ((x >>> 0) % 10000) / 10000;
}

function renderRadar(rows) {
  const R = 210;
  const sectors = practiceList();
  const n = sectors.length;
  const width = 360 / n;
  const rad = (deg) => (deg * Math.PI) / 180;
  // 30점 이하는 가장자리, 100점은 중심 근처. 상위 공고가 중심에 뭉치지 않도록 구간을 넓게 쓴다.
  const radiusFor = (score) => R * (0.12 + 0.88 * ((100 - Math.max(30, Math.min(100, score))) / 70));
  const pt = (r, deg) => [r * Math.cos(rad(deg)), r * Math.sin(rad(deg))];

  const rings = [
    [75, "A"],
    [65, "B"],
    [50, "C"],
    [0, ""],
  ]
    .map(([score, label]) => {
      const r = radiusFor(score);
      return `<circle r="${r.toFixed(1)}" fill="none" stroke="var(--radar-grid)" stroke-width="1" ${
        label ? "" : 'stroke-dasharray="2 4"'
      }/>${
        label
          ? `<text x="-6" y="${(-r + 14).toFixed(1)}" text-anchor="end" fill="#34d1bf" font-size="12" opacity=".85">${label}등급</text>`
          : ""
      }`;
    })
    .join("");

  const spokes = sectors
    .map((p, i) => {
      const start = -90 + i * width;
      const [x, y] = pt(R, start);
      const [lx, ly] = pt(R + 26, start + width / 2);
      const anchor = Math.abs(lx) < 12 ? "middle" : lx > 0 ? "start" : "end";
      return `<line x1="0" y1="0" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--radar-grid)" />
        <text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="${anchor}" fill="var(--radar-text)" font-size="14" font-weight="600">${h(p.label)}</text>`;
    })
    .join("");

  // 60점 이상 상위 45건만 표시해 실제 공고 수천 건에서도 레이더가 읽히도록 한다(전체는 아래 목록에서 확인).
  const nodes = rows
    .filter((x) => !x.s.excluded && x.s.score >= 60)
    .slice(0, 45)
    .map(({ bid, s }) => {
      const idx = Math.max(0, sectors.findIndex((p) => p.id === s.primaryPractice));
      const deg = -90 + idx * width + (0.14 + 0.72 * hash01(bid.id)) * width;
      const [x, y] = pt(radiusFor(s.score), deg);
      const amount = bid.budget ?? bid.estPrice;
      const size = amount ? 5 + 9 * Math.max(0, Math.min(1, Math.log10(amount / 5e7) / 2)) : 5;
      return { bid, s, x, y, size, color: practiceById(s.primaryPractice).color };
    });

  // 상위 공고가 중심부에 겹치지 않도록 서로 밀어낸다(정확한 점수는 툴팁과 목록에서 확인).
  for (let iter = 0; iter < 60; iter++) {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const min = a.size + b.size + 2;
        if (d < min) {
          const push = (min - d) / 2;
          a.x -= (dx / d) * push;
          a.y -= (dy / d) * push;
          b.x += (dx / d) * push;
          b.y += (dy / d) * push;
        }
      }
    }
  }

  const dots = nodes
    .map(({ bid, s, x, y, size, color }) => {
      const halo =
        s.grade === "A"
          ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(size + 5).toFixed(1)}" fill="${color}" opacity=".18"/>`
          : "";
      return `${halo}<circle class="dot" tabindex="0" role="button" data-id="${h(bid.id)}"
        aria-label="${h(`${bid.title}, 적합도 ${s.score}점`)}"
        cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${size.toFixed(1)}" fill="${color}" fill-opacity=".92"/>`;
    })
    .join("");

  const [sx, sy] = pt(R, -38);
  $("#radar").innerHTML = `<svg viewBox="-280 -262 560 524" role="img" aria-label="적합도 레이더 차트">
    <defs>
      <radialGradient id="rg" r="1">
        <stop offset="0" stop-color="#34d1bf" stop-opacity=".10"/>
        <stop offset="1" stop-color="#34d1bf" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <circle r="${R}" fill="url(#rg)"/>
    <g class="sweep"><path d="M0 0 L${R} 0 A${R} ${R} 0 0 0 ${sx.toFixed(1)} ${sy.toFixed(1)} Z" fill="#34d1bf" opacity=".10"/>
      <line x1="0" y1="0" x2="${R}" y2="0" stroke="#34d1bf" stroke-opacity=".55" stroke-width="1.5"/></g>
    ${rings}${spokes}${dots}
    <circle r="3" fill="#34d1bf"/>
  </svg>`;

  $("#radar-legend").innerHTML = sectors
    .map((p) => `<span><i style="background:${p.color}"></i>${h(p.label)}</span>`)
    .join("");
}

function renderDeadlines() {
  const list = state.scored
    .filter((x) => isFit(x) && x.s.daysLeft != null && x.s.daysLeft >= 0)
    .sort((a, b) => a.s.daysLeft - b.s.daysLeft)
    .slice(0, 5);
  $("#deadlines").innerHTML = list.length
    ? list
        .map(
          ({ bid, s }) => `<li><button type="button" data-id="${h(bid.id)}">
          <span class="dday">${dDayLabel(s.daysLeft)}</span>
          <span><span class="t" style="display:block">${h(bid.title)}</span>
          <span class="a">${h(bid.agency)} · ${h(formatKRW(bid.budget ?? bid.estPrice))}</span></span>
        </button></li>`
        )
        .join("")
    : `<li class="empty">마감이 남은 적합 공고가 없습니다.</li>`;
}

function renderPracticeBars() {
  const counts = practiceList().map((p) => {
    const items = state.scored.filter((x) => !x.s.excluded && x.s.score >= 50 && x.s.primaryPractice === p.id);
    return { p, count: items.length, budget: items.reduce((n, x) => n + (x.bid.budget ?? 0), 0) };
  });
  const max = Math.max(1, ...counts.map((c) => c.count));
  $("#practice-bars").innerHTML = counts
    .map(
      ({ p, count }) => `<button type="button" class="bar-row" data-practice="${h(p.id)}"
        style="border:0;background:none;padding:0;cursor:pointer;text-align:left${
          state.practice && state.practice !== p.id ? ";opacity:.45" : ""
        }" aria-pressed="${state.practice === p.id}">
        <span>${h(p.label)}</span>
        <span class="bar-track"><span class="bar-fill" style="display:block;width:${((count / max) * 100).toFixed(
          1
        )}%;background:${p.color}"></span></span>
        <span class="n">${count}건</span></button>`
    )
    .join("");
}

function renderChips() {
  const grades = [
    ["ALL", "전체"],
    ["A", "A 우선 검토"],
    ["B", "B 검토"],
    ["C", "C 관찰"],
    ["D", "D 낮음"],
  ];
  let html = grades
    .map(
      ([g, label]) =>
        `<button type="button" class="chip" data-grade="${g}" aria-pressed="${state.grade === g}">${label}</button>`
    )
    .join("");
  if (state.practice) {
    html += `<button type="button" class="chip" data-practice="${h(state.practice)}" aria-pressed="true">분야: ${h(
      practiceById(state.practice).label
    )} ✕</button>`;
  }
  $("#grade-chips").innerHTML = html;
}

function renderList(rows) {
  $("#list-count").textContent = `${rows.length}건`;
  if (!rows.length) {
    $("#bid-list").innerHTML = `<p class="empty">조건에 맞는 공고가 없습니다.</p>`;
    return;
  }
  $("#bid-list").innerHTML = rows
    .slice(0, 200)
    .map(({ bid, s }) => {
      const tags = (s.practices.length ? s.practices : ["other"])
        .map((id) => practiceById(id))
        .map((p) => `<span class="tag"><i style="background:${p.color}"></i>${h(p.label)}</span>`)
        .join("") +
        (s.similar[0]?.sim >= 0.3 ? `<span class="tag badge">유사 실적</span>` : "") +
        (s.relation?.count >= 3 ? `<span class="tag badge">반복 거래처</span>` : "");
      const inPipe = Boolean(state.pipeline[bid.id]);
      const agency =
        bid.demandAgency && bid.demandAgency !== bid.agency ? `${bid.agency} → ${bid.demandAgency}` : bid.agency;
      return `<button type="button" class="bid-row${s.excluded ? " excluded" : ""}" data-id="${h(bid.id)}">
        <span class="score-badge g-${s.grade}"><b>${s.score}</b><span>${s.grade === "X" ? "제외" : s.grade}</span></span>
        <span class="bid-main">
          <span class="bid-title" style="display:block">${h(bid.title)}</span>
          <span class="bid-meta"><span>${h(agency)}</span>${tags}</span>
        </span>
        <span class="bid-amount">${h(formatKRW(bid.budget ?? bid.estPrice))}</span>
        <span class="bid-dday${s.daysLeft != null && s.daysLeft >= 0 && Math.floor(s.daysLeft) <= 5 ? " urgent" : ""}">${dDayLabel(
        s.daysLeft
      )}</span>
        <span class="star${inPipe ? " on" : ""}" aria-label="${inPipe ? "파이프라인에 있음" : ""}">${inPipe ? "★" : "☆"}</span>
      </button>`;
    })
    .join("");
}

function renderPipelineCount() {
  const n = Object.keys(state.pipeline).length;
  $("#pipeline-count").textContent = n ? String(n) : "";
}

/* ------------------------------------------------------------------ */
/* 상세 서랍                                                            */
/* ------------------------------------------------------------------ */

function findEntry(id) {
  const hit = state.scored.find((x) => x.bid.id === id);
  if (hit) return hit;
  const saved = state.pipeline[id];
  if (saved?.bid) return { bid: saved.bid, s: scoreBid(saved.bid, state.profile, state.now, state.historyIndex) };
  return null;
}

function ring(score, grade) {
  const r = 36;
  const c = 2 * Math.PI * r;
  const color = `var(--grade-${grade === "X" ? "x" : grade.toLowerCase()})`;
  return `<svg class="ring" viewBox="0 0 88 88" role="img" aria-label="적합도 ${score}점">
    <circle cx="44" cy="44" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="8"/>
    <circle cx="44" cy="44" r="${r}" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round"
      stroke-dasharray="${((score / 100) * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 44 44)"/>
    <text x="44" y="46" text-anchor="middle" font-size="24" font-weight="800" fill="currentColor">${score}</text>
    <text x="44" y="62" text-anchor="middle" font-size="11" fill="var(--muted)">${grade === "X" ? "제외" : `${grade}등급`}</text>
  </svg>`;
}

function openDrawer(id) {
  const entry = findEntry(id);
  if (!entry) return;
  state.selectedId = id;
  state.lastFocus = document.activeElement;
  $("#drawer-body").innerHTML = drawerHtml(entry);
  const cached = state.analyses[id];
  if (cached) $("#ai-result").innerHTML = analysisHtml(cached);
  $("#drawer").hidden = false;
  document.body.style.overflow = "hidden";
  $(".drawer-close").focus();
}

function closeDrawer() {
  $("#drawer").hidden = true;
  document.body.style.overflow = "";
  state.selectedId = null;
  state.lastFocus?.focus?.();
}

function drawerHtml({ bid, s }) {
  const pipe = state.pipeline[bid.id];
  const pdf = bid.attachments.find((a) => a.url && /\.pdf$/i.test(a.name));
  const facts = [
    ["공고기관", bid.agency],
    ["수요기관", bid.demandAgency || "미기재"],
    ["게시일시", formatDateTime(bid.postedAt)],
    ["입찰 마감", `${formatDateTime(bid.closeAt)} (${dDayLabel(s.daysLeft)})`],
    ["개찰일시", formatDateTime(bid.openAt)],
    ["공고번호", `${bid.no}-${bid.ord}`],
    ["배정예산", formatKRW(bid.budget)],
    ["추정가격", formatKRW(bid.estPrice)],
    ["계약방법", bid.contractMethod || "미기재"],
    ["낙찰방법", bid.awardMethod || "미기재"],
  ];
  const aiMode = state.health.ai
    ? "Claude가 공고 정보와 (선택한) 제안요청서를 읽고 참여 판단과 제안 착수 메모를 작성합니다. 30초에서 1분 정도 걸립니다."
    : "AI 키가 설정되지 않아 공고명 기반의 규칙 기반 초안을 보여 줍니다. 서버에 ANTHROPIC_API_KEY를 설정하면 Claude 분석으로 전환됩니다.";

  return `
  <div class="d-head">
    ${ring(s.score, s.grade)}
    <div>
      <h3 id="drawer-title">${h(bid.title)}</h3>
      <div class="sub">${h(bid.agency)}${state.source === "demo" ? " · 데모 공고" : ""}</div>
    </div>
  </div>

  <div class="d-actions">
    <select id="stage-select" aria-label="파이프라인 단계">
      <option value="">${pipe ? "파이프라인에서 빼기" : "파이프라인에 추가…"}</option>
      ${STAGES.map((st) => `<option value="${st.id}" ${pipe?.stage === st.id ? "selected" : ""}>${st.label}</option>`).join("")}
    </select>
    ${
      bid.url
        ? `<a class="btn" href="${h(bid.url)}" target="_blank" rel="noopener noreferrer">나라장터 원문 보기</a>`
        : ""
    }
  </div>

  <div class="d-section">
    <h4>공고 정보</h4>
    <dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${h(v)}</dd></div>`).join("")}</dl>
  </div>

  <div class="d-section">
    <h4>적합도 구성</h4>
    <div class="breakdown">
      ${BREAKDOWN.map(([key, label, max]) => {
        const v = s.breakdown[key];
        if (v == null) {
          return `<div class="bd-row"><span>${label}</span><span class="muted" style="font-size:12px">팀 실적을 불러오면 반영됩니다</span><span class="n">미반영</span></div>`;
        }
        return `<div class="bd-row"><span>${label}</span>
        <span class="bar-track"><span class="bar-fill" style="display:block;width:${((v / max) * 100).toFixed(
          0
        )}%;background:var(--accent)"></span></span>
        <span class="n">${v} / ${max}</span></div>`;
      }).join("")}
    </div>
    <ul class="reasons">${s.reasons.map((r) => `<li>${h(r)}</li>`).join("")}</ul>
    ${state.historyIndex ? "" : `<p class="muted" style="font-size:12px;margin-top:8px">실적 미반영 상태이므로 80점 만점을 100점으로 환산했습니다.</p>`}
  </div>

  ${
    s.similar.length
      ? `<div class="d-section"><h4>유사 수행 실적 (팀 실적 ${state.historyIndex.size}건 중)</h4>
        <ol class="similar">${s.similar
          .map(
            (x) => `<li><span class="sim">${Math.round(x.sim * 100)}%</span>
            <span><b>${h(x.title)}</b><span class="muted">${h([x.client, x.year && `${x.year}년`].filter(Boolean).join(" · "))}</span></span></li>`
          )
          .join("")}</ol>
        <p class="muted" style="font-size:12px;margin-top:6px">제안서의 유사 수행 실적 항목과 투입 인력 선정에 참고할 수 있습니다. 이 목록은 브라우저 밖으로 전송되지 않습니다.</p></div>`
      : ""
  }

  ${
    bid.attachments.length
      ? `<div class="d-section"><h4>첨부파일</h4><div class="files">${bid.attachments
          .map((a) =>
            a.url
              ? `<a class="file" href="${h(a.url)}" target="_blank" rel="noopener noreferrer">${h(a.name)}</a>`
              : `<span class="file">${h(a.name)}</span>`
          )
          .join("")}</div></div>`
      : ""
  }

  <div class="d-section">
    <h4>AI 수주 전략 분석</h4>
    <div class="ai-box">
      <p class="muted" style="font-size:13px;margin-bottom:10px">${aiMode}</p>
      <textarea id="rfp-text" placeholder="(선택) 제안요청서나 과업지시서 본문을 붙여 넣으면 분석이 훨씬 구체적으로 바뀝니다. HWP 문서는 본문을 복사해 붙여 넣으십시오."></textarea>
      <div class="ai-controls">
        <button id="run-ai" class="btn primary" type="button">${
          state.analyses[bid.id] ? "다시 분석" : state.health.ai ? "AI 수주 전략 분석" : "규칙 기반 초안 보기"
        }</button>
        ${
          pdf && state.health.ai
            ? `<label class="switch"><input id="use-pdf" type="checkbox" checked /> 첨부 PDF(${h(
                pdf.name
              )})도 함께 읽기</label>`
            : ""
        }
      </div>
      <div id="ai-result"></div>
    </div>
  </div>

  <div class="d-section">
    <h4>검토 메모</h4>
    <textarea id="pipe-memo" class="field" style="width:100%;min-height:70px;padding:10px;border:1px solid var(--border);border-radius:10px;background:var(--surface)"
      placeholder="${pipe ? "팀 내 검토 의견을 적어 두십시오." : "파이프라인에 추가하면 메모를 남길 수 있습니다."}" ${pipe ? "" : "disabled"}>${h(
    pipe?.memo || ""
  )}</textarea>
  </div>`;
}

// AI로 보내는 점수 근거에서는 팀의 과거 과업명·거래처·건수를 지운다(내부 실적 정보 외부 전송 방지).
function publicReasons(s) {
  return s.reasons.map((r) => {
    if (r.startsWith("유사 실적:")) {
      const top = s.similar[0];
      return top ? `유사 실적: 팀에 유사한 과거 수행 과업이 있음(최고 유사도 ${Math.round(top.sim * 100)}%)` : r;
    }
    if (r.startsWith("거래 관계:")) return "거래 관계: 해당 발주처와 수행 이력이 있음";
    return r;
  });
}

async function runAnalysis() {
  const id = state.selectedId;
  const entry = findEntry(id);
  if (!entry) return;
  const out = $("#ai-result");
  const btn = $("#run-ai");

  if (!state.health.ai) {
    out.innerHTML = analysisHtml({ analysis: buildDraftAnalysis(entry.bid, entry.s), draft: true });
    return;
  }

  const rfpText = $("#rfp-text")?.value.trim() || "";
  const pdf = $("#use-pdf")?.checked ? entry.bid.attachments.find((a) => a.url && /\.pdf$/i.test(a.name)) : null;
  btn.disabled = true;
  out.innerHTML = `<div class="loading"><span class="spinner"></span>Claude가 공고${
    pdf || rfpText ? "와 제안요청서" : ""
  }를 검토하고 있습니다.</div>`;

  try {
    const headers = { "Content-Type": "application/json" };
    const code = store.get(KEYS.access, "");
    if (code) headers["x-access-code"] = code;
    const res = await fetch("api/analyze", {
      method: "POST",
      headers,
      body: JSON.stringify({
        bid: entry.bid,
        profile: {
          name: state.profile.name,
          practices: state.profile.practices.map((p) => ({ label: p.label })),
          keyAccounts: state.profile.keyAccounts,
        },
        score: { score: entry.s.score, grade: entry.s.grade, reasons: publicReasons(entry.s) },
        rfpText,
        pdfUrl: pdf?.url || null,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.code === "FORBIDDEN") throw new Error("접근 코드가 필요합니다. 역량 프로필 화면에서 AI 접근 코드를 입력하십시오.");
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    state.analyses[id] = data;
    store.set(KEYS.analyses, state.analyses);
    if (state.selectedId === id) out.innerHTML = analysisHtml(data);
    btn.textContent = "다시 분석";
  } catch (err) {
    out.innerHTML = `<p class="loading" style="color:var(--danger)">${h(err.message)}</p>
      ${analysisHtml({ analysis: buildDraftAnalysis(entry.bid, entry.s), draft: true })}`;
  } finally {
    btn.disabled = false;
  }
}

function analysisHtml(result) {
  const a = result.analysis;
  const list = (items) => `<ul>${(items || []).map((x) => `<li>${h(x)}</li>`).join("")}</ul>`;
  const meta = result.draft
    ? "규칙 기반 초안입니다. 공고명만으로 작성했으므로 제안요청서 확인 후 판단을 갱신해야 합니다."
    : `${h(result.model || "Claude")} 분석 · ${h(formatDateTime(result.generatedAt))}${
        result.sources?.pdf ? ` · 첨부 문서: ${h(result.sources.pdf)}` : ""
      }${result.sources?.rfpText ? " · 붙여 넣은 본문 반영" : ""}${result.sources?.note ? ` · ${h(result.sources.note)}` : ""}`;

  return `<div class="memo" style="margin-top:14px">
    <div class="verdict ${h(a.go_no_go.decision)}"><b>${h(DECISION_LABEL[a.go_no_go.decision] || a.go_no_go.decision)}</b>
      <p>${h(a.go_no_go.rationale)}</p></div>
    <h5>과업 요약</h5><p>${h(a.summary)}</p>
    <h5>발주처 의도</h5>${list(a.client_intent)}
    <h5>우리 역량과의 적합도</h5><p>${h(a.fit_assessment)}</p>
    <h5>수주 전략 (Win Themes)</h5>
    <ul>${a.win_themes.map((w) => `<li><b>${h(w.title)}</b> : ${h(w.detail)}</li>`).join("")}</ul>
    <h5>제안서 목차 초안</h5>
    <ol class="outline">${a.proposal_outline
      .map((o) => `<li><b>${h(o.section)}</b><span>${h(o.key_message)}</span></li>`)
      .join("")}</ol>
    <h5>필요 전문가</h5>${list(a.required_experts)}
    <h5>리스크와 대응</h5>
    <ul>${a.risks.map((r) => `<li><b>${h(r.risk)}</b> : ${h(r.mitigation)}</li>`).join("")}</ul>
    <h5>발주처 질의 사항</h5>${list(a.clarification_questions)}
    <div class="ai-controls"><button id="copy-memo" class="btn" type="button">제안 착수 메모 복사</button></div>
    <p class="note">${meta}</p>
  </div>`;
}

function analysisMarkdown(bid, result) {
  const a = result.analysis;
  const lines = [
    `# 제안 착수 메모: ${bid.title}`,
    "",
    `- 공고기관: ${bid.agency}`,
    `- 배정예산: ${formatKRW(bid.budget)}`,
    `- 입찰 마감: ${formatDateTime(bid.closeAt)}`,
    `- 판단: ${DECISION_LABEL[a.go_no_go.decision] || a.go_no_go.decision}`,
    "",
    `## 판단 근거`,
    a.go_no_go.rationale,
    "",
    "## 과업 요약",
    a.summary,
    "",
    "## 발주처 의도",
    ...a.client_intent.map((x) => `- ${x}`),
    "",
    "## 수주 전략",
    ...a.win_themes.map((w) => `- **${w.title}** : ${w.detail}`),
    "",
    "## 제안서 목차 초안",
    ...a.proposal_outline.map((o, i) => `${i + 1}. ${o.section} : ${o.key_message}`),
    "",
    "## 필요 전문가",
    ...a.required_experts.map((x) => `- ${x}`),
    "",
    "## 리스크와 대응",
    ...a.risks.map((r) => `- ${r.risk} : ${r.mitigation}`),
    "",
    "## 발주처 질의 사항",
    ...a.clarification_questions.map((x) => `- ${x}`),
  ];
  if (result.draft) lines.push("", "_규칙 기반 초안입니다._");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* 파이프라인                                                          */
/* ------------------------------------------------------------------ */

function savePipeline() {
  store.set(KEYS.pipeline, state.pipeline);
  renderPipelineCount();
}

function setStage(id, stage) {
  if (!stage) {
    delete state.pipeline[id];
  } else if (state.pipeline[id]) {
    state.pipeline[id].stage = stage;
  } else {
    const entry = findEntry(id);
    if (!entry) return;
    state.pipeline[id] = {
      stage,
      memo: "",
      addedAt: new Date().toISOString(),
      bid: entry.bid,
      demo: state.source === "demo",
    };
  }
  savePipeline();
}

function renderBoard() {
  const items = Object.entries(state.pipeline).map(([id, p]) => {
    const s = scoreBid(p.bid, state.profile, state.now, state.historyIndex);
    return { id, p, s };
  });
  $("#board").innerHTML = STAGES.map((st) => {
    const cards = items.filter((x) => x.p.stage === st.id);
    const sum = cards.reduce((n, x) => n + (x.p.bid.budget ?? 0), 0);
    return `<div class="col" data-stage="${st.id}">
      <h3><span>${st.label}</span><span>${cards.length}</span></h3>
      <div class="sum">${sum ? h(formatKRW(sum)) : ""}</div>
      ${cards
        .map(
          ({ id, p, s }) => `<div class="pcard" draggable="true" data-card="${h(id)}">
          <div class="t">${h(p.bid.title)}</div>
          <div class="m"><span>${h(p.bid.agency)}</span><span>${dDayLabel(s.daysLeft)}</span></div>
          <div class="m"><span>${h(formatKRW(p.bid.budget))}</span><span>${s.score}점</span></div>
          <select data-move="${h(id)}" aria-label="단계 변경">
            ${STAGES.map((o) => `<option value="${o.id}" ${o.id === st.id ? "selected" : ""}>${o.label}</option>`).join("")}
            <option value="">파이프라인에서 빼기</option>
          </select>
        </div>`
        )
        .join("")}
    </div>`;
  }).join("");
}

function exportCsv() {
  const rows = [["단계", "공고번호", "공고명", "공고기관", "배정예산(원)", "입찰마감", "적합도", "메모"]];
  for (const p of Object.values(state.pipeline)) {
    const s = scoreBid(p.bid, state.profile, state.now, state.historyIndex);
    rows.push([
      STAGES.find((x) => x.id === p.stage)?.label || p.stage,
      `${p.bid.no}-${p.bid.ord}`,
      p.bid.title,
      p.bid.agency,
      p.bid.budget ?? "",
      formatDateTime(p.bid.closeAt),
      s.score,
      p.memo || "",
    ]);
  }
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `rfp-pipeline-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ------------------------------------------------------------------ */
/* 주간 브리핑                                                          */
/* ------------------------------------------------------------------ */

function buildBrief() {
  const fit = state.scored.filter(isFit);
  const A = fit.filter((x) => x.s.grade === "A");
  const B = fit.filter((x) => x.s.grade === "B");
  const budget = fit.reduce((n, x) => n + (x.bid.budget ?? 0), 0);
  const begin = new Date(state.now.getTime() - state.days * DAY_MS).toISOString();
  const line = ({ bid, s }, i) =>
    `${i + 1}. ${bid.title}\n   ${bid.agency} · ${formatKRW(bid.budget ?? bid.estPrice)} · 마감 ${formatDateTime(
      bid.closeAt
    )}(${dDayLabel(s.daysLeft)}) · 적합도 ${s.score}점`;

  const byPractice = practiceList()
    .map((p) => [p.label, fit.filter((x) => x.s.primaryPractice === p.id).length])
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${label} ${n}건`)
    .join(", ");

  const soon = fit.filter((x) => x.s.daysLeft != null && x.s.daysLeft >= 0 && x.s.daysLeft <= 7);

  return [
    `[RFP Radar] 공공 컨설팅 입찰 브리핑 (${formatDateTime(begin, { time: false })} ~ ${formatDateTime(
      state.now.toISOString(),
      { time: false }
    )})`,
    state.source === "demo" ? "※ 데모 데이터(가상 공고) 기준입니다." : "",
    "",
    `이번 기간 나라장터 용역 공고 ${state.scored.length}건을 검토했고, 이 가운데 적합 기회는 ${fit.length}건(A등급 ${A.length}건, B등급 ${B.length}건)입니다. 적합 기회의 배정예산 합계는 ${formatKRW(
      budget || null
    )}입니다.`,
    byPractice ? `분야별로는 ${byPractice}이 확인되었습니다.` : "",
    "",
    "■ 우선 검토 (A등급)",
    ...(A.length ? A.slice(0, 7).map(line) : ["해당 공고가 없습니다."]),
    "",
    "■ 검토 대상 (B등급 상위 5건)",
    ...(B.length ? B.slice(0, 5).map(line) : ["해당 공고가 없습니다."]),
    "",
    "■ 7일 안에 마감되는 적합 공고",
    ...(soon.length
      ? soon
          .sort((a, b) => a.s.daysLeft - b.s.daysLeft)
          .map(({ bid, s }) => `- ${dDayLabel(s.daysLeft)} ${bid.title} (${bid.agency})`)
      : ["해당 공고가 없습니다."]),
    "",
    "적합도는 역량 프로필 기반의 규칙 점수이므로, 참여 여부는 제안요청서 확인 후 결정해야 합니다.",
  ]
    .filter((l, i, arr) => !(l === "" && arr[i - 1] === ""))
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* 역량 프로필                                                          */
/* ------------------------------------------------------------------ */

const EOK = 1e8;
const joinList = (arr) => (arr || []).join(", ");
const splitList = (text) =>
  String(text || "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

function renderProfileForm() {
  const p = state.profile;
  const b = p.budget;
  const area = (name, label, value, rows = 2) =>
    `<label class="field"><span>${label}</span><textarea name="${name}" rows="${rows}">${h(value)}</textarea></label>`;
  const num = (name, label, value) =>
    `<label class="field"><span>${label}</span><input type="number" min="0" step="0.1" name="${name}" value="${value / EOK}" /></label>`;

  $("#profile-fields").innerHTML = `
    <label class="field"><span>프로필 이름</span><input name="name" value="${h(p.name)}" /></label>
    <fieldset><legend>분야별 가중치와 키워드</legend><div class="grid2">
      ${p.practices
        .map(
          (pr) => `<div class="field"><span style="display:flex;justify-content:space-between;align-items:center;gap:8px">
            <b style="color:var(--text)">${h(pr.label)}</b>
            <select name="weight:${pr.id}" aria-label="${h(pr.label)} 가중치" style="width:auto;padding:4px 8px">
              ${WEIGHTS.map((w) => `<option value="${w.value}" ${w.value === pr.weight ? "selected" : ""}>${w.label}</option>`).join("")}
            </select></span>
            <textarea name="practice:${pr.id}" rows="3" aria-label="${h(pr.label)} 키워드">${h(joinList(pr.keywords))}</textarea></div>`
        )
        .join("")}
    </div></fieldset>
    ${area("signals", "컨설팅성 과업 신호 키워드 (조건부 제외를 무효로 만드는 근거로도 쓰임)", joinList(p.signals))}
    <div class="grid2">
      ${area("hardExclusions", "항상 제외 (청소·구매·안전진단 등)", joinList(p.hardExclusions), 3)}
      ${area("exclusions", "조건부 제외 (컨설팅성 신호가 없을 때만 제외)", joinList(p.exclusions), 3)}
    </div>
    ${area("keyAccounts", `핵심 발주처 (수동 지정${p.clients?.length ? `, 팀 실적 거래처 ${p.clients.length}곳은 자동 반영` : ""})`, joinList(p.keyAccounts))}
    <fieldset><legend>사업 규모 (억원)</legend><div class="grid4">
      ${num("min", "참여 하한", b.min)}${num("idealMin", "선호 구간 하한", b.idealMin)}
      ${num("idealMax", "선호 구간 상한", b.idealMax)}${num("max", "참여 상한", b.max)}
    </div></fieldset>
    <fieldset><legend>AI 분석 접근 코드</legend>
      <label class="field"><span>서버에 ACCESS_CODE를 설정한 경우에만 입력합니다.</span>
      <input type="password" name="access" autocomplete="off" value="${h(store.get(KEYS.access, ""))}" /></label>
    </fieldset>`;
}

function saveProfileForm(form) {
  const fd = new FormData(form);
  const p = state.profile;
  p.name = String(fd.get("name") || "").trim() || DEFAULT_PROFILE.name;
  p.practices = p.practices.map((pr) => ({
    ...pr,
    weight: Number(fd.get(`weight:${pr.id}`)) || pr.weight,
    keywords: splitList(fd.get(`practice:${pr.id}`)),
  }));
  p.signals = splitList(fd.get("signals"));
  p.hardExclusions = splitList(fd.get("hardExclusions"));
  p.exclusions = splitList(fd.get("exclusions"));
  p.keyAccounts = splitList(fd.get("keyAccounts"));
  const toWon = (name, fallback) => {
    const v = Number(fd.get(name));
    return Number.isFinite(v) && v >= 0 ? Math.round(v * EOK) : fallback;
  };
  p.budget = {
    min: toWon("min", p.budget.min),
    idealMin: toWon("idealMin", p.budget.idealMin),
    idealMax: toWon("idealMax", p.budget.idealMax),
    max: toWon("max", p.budget.max),
  };
  p.version = PROFILE_VERSION;
  store.set(KEYS.profile, p);
  const access = String(fd.get("access") || "").trim();
  if (access) store.set(KEYS.access, access);
  else store.remove(KEYS.access);
}

/* ------------------------------------------------------------------ */
/* 팀 수행 실적                                                         */
/* ------------------------------------------------------------------ */

function renderTeamCard() {
  const t = state.teamSummary;
  const el = $("#team-body");
  if (!t) {
    el.innerHTML = `<p>과거 수행 실적 파일(엑셀·CSV)을 불러오면 <b>유사 실적</b>, <b>반복 거래처</b>, <b>주력 수주 금액 구간</b>, <b>분야별 가중치</b>를 자동으로 계산해 적합도 점수에 반영합니다.</p>
      <p class="muted" style="margin-top:6px;font-size:13px">필요한 열은 과업명(적요·사업명), 거래처(발주처), 등록월(계약일·연도), 계약금액입니다. 파일은 이 브라우저 안에서만 읽고 서버나 AI로 보내지 않습니다.</p>`;
    $("#team-clear").hidden = true;
    $("#team-pick").textContent = "실적 파일 불러오기";
    return;
  }
  const s = t.summary;
  const practices = t.profile.practices;
  const maxShare = Math.max(...practices.map((p) => p.share || 0), 1);
  const weightLabel = (w) => WEIGHTS.find((x) => x.value === w)?.label || "";
  el.innerHTML = `
    <div class="team-stats">
      <div><span>수행 실적</span><b>${s.records.toLocaleString("ko-KR")}건</b><small>${s.from ?? "?"}~${s.to ?? "?"}년</small></div>
      <div><span>거래처</span><b>${s.clients}곳</b><small>3건 이상 반복 ${s.repeatClients}곳</small></div>
      <div><span>주력 수주 구간</span><b>${h(formatKRW(s.budget.idealMin))} ~ ${h(formatKRW(s.budget.idealMax))}</b><small>최근 5년 계약금액 40~90% 구간</small></div>
    </div>
    <div class="team-grid">
      <div>
        <h4>분야별 실적 비중과 자동 가중치</h4>
        <div class="bars">${practices
          .map(
            (p) => `<div class="bar-row"><span>${h(p.label)}</span>
            <span class="bar-track"><span class="bar-fill" style="display:block;width:${(((p.share || 0) / maxShare) * 100).toFixed(1)}%;background:${p.color}"></span></span>
            <span class="n">${p.share ?? 0}% · ${weightLabel(p.weight)}</span></div>`
          )
          .join("")}</div>
      </div>
      <div>
        <h4>반복 거래처 상위 10곳</h4>
        <ol class="clients">${(t.profile.clients || [])
          .slice(0, 10)
          .map((c) => `<li><span>${h(c.name)}</span><span class="muted">${c.count}건</span></li>`)
          .join("")}</ol>
      </div>
    </div>`;
  $("#team-clear").hidden = false;
  $("#team-pick").textContent = "다른 파일로 교체";
}

let sheetJsPromise;
function loadSheetJs() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  sheetJsPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error("엑셀 해석 라이브러리를 불러오지 못했습니다. CSV로 저장해 불러오십시오."));
    document.head.appendChild(s);
  });
  return sheetJsPromise;
}

// 한국어 엑셀이 저장한 CSV는 대개 EUC-KR 이므로 UTF-8 해석이 실패하면 EUC-KR로 다시 읽는다.
async function decodeText(file) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("euc-kr").decode(buf);
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

async function readTrackRecord(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".json")) {
    const data = JSON.parse(await decodeText(file));
    return Array.isArray(data) ? data : data.records || data.history || [];
  }
  if (name.endsWith(".csv")) return rowsToRecords(parseCsv(await decodeText(file)));
  const XLSX = await loadSheetJs();
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  let lastError;
  for (const sheetName of wb.SheetNames) {
    try {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: "" });
      const records = rowsToRecords(rows);
      if (records.length) return records;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("실적 행을 찾지 못했습니다.");
}

async function importTrackRecord(file) {
  const btn = $("#team-pick");
  btn.disabled = true;
  btn.textContent = "분석 중…";
  try {
    const records = await readTrackRecord(file);
    if (!records.length) throw new Error("실적 행을 찾지 못했습니다.");
    const team = buildTeamProfile(records, state.profile);
    state.profile = { ...team.profile, version: PROFILE_VERSION };
    state.teamSummary = { summary: team.summary, profile: state.profile };
    state.historyIndex = buildHistoryIndex(team.history);
    store.set(KEYS.profile, state.profile);
    store.set(KEYS.history, team.history);
    store.set(KEYS.teamSummary, state.teamSummary);
    rescore();
    render();
    renderProfileForm();
    toast(`팀 실적 ${records.length.toLocaleString("ko-KR")}건을 반영해 점수를 다시 계산했습니다.`);
  } catch (err) {
    toast(`실적 파일을 읽지 못했습니다. ${err.message}`);
  } finally {
    btn.disabled = false;
    renderTeamCard();
  }
}

function clearTrackRecord() {
  store.remove(KEYS.history);
  store.remove(KEYS.teamSummary);
  store.remove(KEYS.profile);
  state.teamSummary = null;
  state.historyIndex = null;
  state.profile = { ...clone(DEFAULT_PROFILE), version: PROFILE_VERSION };
  renderTeamCard();
  renderProfileForm();
  rescore();
  render();
  toast("팀 실적을 지우고 기본 프로필로 돌아갔습니다.");
}

/* ------------------------------------------------------------------ */
/* 공통 UI                                                             */
/* ------------------------------------------------------------------ */

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("클립보드에 복사했습니다.");
  } catch {
    toast("복사하지 못했습니다. 직접 선택해 복사하십시오.");
  }
}

function setBusy(busy) {
  const btn = $("#refresh");
  btn.disabled = busy;
  btn.textContent = busy ? "수집 중…" : "새로 수집";
}

function switchTab(tab) {
  for (const btn of document.querySelectorAll(".tabs button")) {
    btn.setAttribute("aria-selected", String(btn.dataset.tab === tab));
  }
  for (const panel of document.querySelectorAll(".tab-panel")) {
    panel.hidden = panel.id !== `tab-${tab}`;
  }
  if (tab === "pipeline") renderBoard();
  if (tab === "settings") {
    renderTeamCard();
    renderProfileForm();
  }
}

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

let tipEl;
function showTip(target) {
  const entry = findEntry(target.dataset.id);
  if (!entry) return;
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "radar-tip";
    document.body.appendChild(tipEl);
  }
  const { bid, s } = entry;
  tipEl.innerHTML = `<strong>${h(bid.title)}</strong><br />${h(bid.agency)} · ${h(
    formatKRW(bid.budget ?? bid.estPrice)
  )}<br />적합도 ${s.score}점 · ${dDayLabel(s.daysLeft)}`;
  const rect = target.getBoundingClientRect();
  const left = Math.min(window.innerWidth - 290, rect.right + 10);
  tipEl.style.left = `${Math.max(8, left)}px`;
  tipEl.style.top = `${Math.max(8, rect.top - 10)}px`;
  tipEl.hidden = false;
}
function hideTip() {
  if (tipEl) tipEl.hidden = true;
}

/* ------------------------------------------------------------------ */
/* 이벤트                                                              */
/* ------------------------------------------------------------------ */

function bindEvents() {
  document.querySelector(".tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tab]");
    if (btn) switchTab(btn.dataset.tab);
  });

  $("#theme-toggle").addEventListener("click", () => {
    const current =
      document.documentElement.dataset.theme ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    applyTheme(next);
    store.set(KEYS.theme, next);
  });

  $("#days").addEventListener("change", (e) => {
    state.days = Number(e.target.value);
    loadBids();
  });
  $("#refresh").addEventListener("click", () => loadBids());

  let searchTimer;
  $("#search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = e.target.value;
      render();
    }, 150);
  });
  $("#show-excluded").addEventListener("change", (e) => {
    state.showExcluded = e.target.checked;
    render();
  });

  $("#grade-chips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    if (chip.dataset.grade) state.grade = chip.dataset.grade;
    if (chip.dataset.practice) state.practice = null;
    render();
  });
  $("#practice-bars").addEventListener("click", (e) => {
    const row = e.target.closest("[data-practice]");
    if (!row) return;
    state.practice = state.practice === row.dataset.practice ? null : row.dataset.practice;
    render();
  });

  // 목록·마감·레이더에서 공고 열기
  for (const sel of ["#bid-list", "#deadlines", "#radar"]) {
    $(sel).addEventListener("click", (e) => {
      const target = e.target.closest("[data-id]");
      if (target) {
        hideTip();
        openDrawer(target.dataset.id);
      }
    });
  }
  $("#radar").addEventListener("keydown", (e) => {
    const dot = e.target.closest(".dot");
    if (dot && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      openDrawer(dot.dataset.id);
    }
  });
  $("#radar").addEventListener("pointerover", (e) => {
    const dot = e.target.closest(".dot");
    if (dot) showTip(dot);
  });
  $("#radar").addEventListener("focusin", (e) => {
    const dot = e.target.closest(".dot");
    if (dot) showTip(dot);
  });
  $("#radar").addEventListener("pointerout", hideTip);
  $("#radar").addEventListener("focusout", hideTip);

  // 서랍
  $("#drawer").addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) closeDrawer();
    if (e.target.closest("#run-ai")) runAnalysis();
    if (e.target.closest("#copy-memo")) {
      const entry = findEntry(state.selectedId);
      const result = state.analyses[state.selectedId] || {
        analysis: buildDraftAnalysis(entry.bid, entry.s),
        draft: true,
      };
      copyText(analysisMarkdown(entry.bid, result));
    }
  });
  $("#drawer").addEventListener("change", (e) => {
    if (e.target.id === "stage-select") {
      const id = state.selectedId;
      setStage(id, e.target.value);
      const memo = $("#pipe-memo");
      memo.disabled = !state.pipeline[id];
      e.target.options[0].textContent = state.pipeline[id] ? "파이프라인에서 빼기" : "파이프라인에 추가…";
      toast(state.pipeline[id] ? "파이프라인에 반영했습니다." : "파이프라인에서 뺐습니다.");
      render();
    }
  });
  $("#drawer").addEventListener("input", (e) => {
    if (e.target.id === "pipe-memo" && state.pipeline[state.selectedId]) {
      state.pipeline[state.selectedId].memo = e.target.value;
      savePipeline();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#drawer").hidden) closeDrawer();
  });

  // 파이프라인 보드
  const board = $("#board");
  board.addEventListener("change", (e) => {
    const sel = e.target.closest("select[data-move]");
    if (!sel) return;
    setStage(sel.dataset.move, sel.value);
    renderBoard();
    render();
  });
  board.addEventListener("click", (e) => {
    const card = e.target.closest(".pcard");
    if (card && !e.target.closest("select")) openDrawer(card.dataset.card);
  });
  board.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".pcard");
    if (card) e.dataTransfer.setData("text/plain", card.dataset.card);
  });
  board.addEventListener("dragover", (e) => {
    const col = e.target.closest(".col");
    if (!col) return;
    e.preventDefault();
    for (const c of board.querySelectorAll(".col.drop")) if (c !== col) c.classList.remove("drop");
    col.classList.add("drop");
  });
  board.addEventListener("dragleave", (e) => {
    const col = e.target.closest(".col");
    if (col && !col.contains(e.relatedTarget)) col.classList.remove("drop");
  });
  board.addEventListener("drop", (e) => {
    const col = e.target.closest(".col");
    if (!col) return;
    e.preventDefault();
    col.classList.remove("drop");
    const id = e.dataTransfer.getData("text/plain");
    if (id) {
      setStage(id, col.dataset.stage);
      renderBoard();
      render();
    }
  });
  $("#export-csv").addEventListener("click", exportCsv);

  // 프로필
  $("#profile-form").addEventListener("submit", (e) => {
    e.preventDefault();
    saveProfileForm(e.target);
    rescore();
    render();
    toast("역량 프로필을 저장하고 점수를 다시 계산했습니다.");
  });
  $("#reset-profile").addEventListener("click", () => {
    const team = state.teamSummary?.profile;
    state.profile = team ? clone(team) : { ...clone(DEFAULT_PROFILE), version: PROFILE_VERSION };
    store.set(KEYS.profile, state.profile);
    renderProfileForm();
    rescore();
    render();
    toast(team ? "팀 실적 기반 프로필로 복원했습니다." : "기본 프로필로 복원했습니다.");
  });

  // 팀 실적
  $("#team-pick").addEventListener("click", () => $("#team-file").click());
  $("#team-file").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) importTrackRecord(file);
    e.target.value = "";
  });
  $("#team-clear").addEventListener("click", clearTrackRecord);

  // 브리핑
  $("#brief").addEventListener("click", () => {
    $("#brief-text").value = buildBrief();
    $("#brief-dialog").showModal();
  });
  $("#brief-copy").addEventListener("click", () => copyText($("#brief-text").value));
}

/* ------------------------------------------------------------------ */

async function init() {
  applyTheme(store.get(KEYS.theme, null));
  bindEvents();
  await checkHealth();
  await loadBids();
}

init();
