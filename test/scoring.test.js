import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PROFILE, scoreBid, hasKeyword, gradeOf, findRelation } from "../public/js/scoring.js";
import { formatKRW } from "../public/js/format.js";

const NOW = new Date("2026-10-01T09:00:00+09:00");
const inDays = (d) => new Date(NOW.getTime() + d * 86400000).toISOString();

const base = {
  id: "T-000",
  no: "T",
  ord: "000",
  agency: "국토교통부",
  demandAgency: "국토교통부",
  contractMethod: "제한경쟁",
  awardMethod: "협상에의한계약",
  budget: 300_000_000,
  estPrice: null,
  attachments: [],
};

test("주력 분야·핵심 발주처·협상 계약 공고는 A등급을 받는다", () => {
  const s = scoreBid({ ...base, title: "종전부동산 활용 활성화 방안 연구용역", closeAt: inDays(15) }, DEFAULT_PROFILE, NOW);
  assert.equal(s.excluded, false);
  assert.equal(s.grade, "A", `score=${s.score}`);
  assert.equal(s.breakdown.similarity, null, "실적이 없으면 유사 실적은 미반영");
});

test("항상 제외 키워드는 컨설팅성 신호가 있어도 제외한다", () => {
  const s = scoreBid({ ...base, title: "청사 정밀안전진단 및 실태조사 용역", closeAt: inDays(10) }, DEFAULT_PROFILE, NOW);
  assert.equal(s.excluded, true);
  assert.equal(s.grade, "X");
  assert.ok(s.score <= 15);
});

test("조건부 제외 키워드는 컨설팅성 신호가 있으면 제외하지 않는다", () => {
  const consulting = scoreBid({ ...base, title: "철도차량 유지보수 수탁비용 산정기준 마련", closeAt: inDays(10) }, DEFAULT_PROFILE, NOW);
  const operation = scoreBid({ ...base, title: "통신 및 보안시스템 통합 유지보수 사업", closeAt: inDays(10) }, DEFAULT_PROFILE, NOW);
  assert.equal(consulting.excluded, false);
  assert.equal(operation.excluded, true);
});

test("마감이 지난 공고는 준비 기간 점수가 0이다", () => {
  const s = scoreBid({ ...base, title: "도시재생 성과분석 연구", closeAt: inDays(-1) }, DEFAULT_PROFILE, NOW);
  assert.equal(s.breakdown.timing, 0);
});

test("예산이 수행 경험 범위 밖이면 규모 점수가 0이다", () => {
  const s = scoreBid({ ...base, title: "도시재생 성과분석 연구", budget: 9_000_000_000, closeAt: inDays(10) }, DEFAULT_PROFILE, NOW);
  assert.equal(s.breakdown.scale, 0);
});

test("영문 약어는 단어 경계로만 일치한다", () => {
  assert.equal(hasKeyword("공공부문 AI 도입 실태조사", "AI"), true);
  assert.equal(hasKeyword("MAIN 서버 교체", "AI"), false);
  assert.equal(hasKeyword("정보화전략계획(ISP) 수립", "ISP"), true);
});

test("등급 경계", () => {
  assert.equal(gradeOf(75), "A");
  assert.equal(gradeOf(74), "B");
  assert.equal(gradeOf(65), "B");
  assert.equal(gradeOf(50), "C");
  assert.equal(gradeOf(49), "D");
});

test("같은 키워드 수라도 인접 분야는 주력 분야보다 낮은 점수를 받는다", () => {
  const common = { ...base, agency: "OO시", demandAgency: "OO시", closeAt: inDays(15) };
  const main = scoreBid({ ...common, title: "유휴부지 활용 연구" }, DEFAULT_PROFILE, NOW);
  const adjacent = scoreBid({ ...common, title: "클라우드 전환 연구" }, DEFAULT_PROFILE, NOW);
  assert.ok(main.breakdown.capability > adjacent.breakdown.capability);
});

test("조달청 대리 발주 공고는 수요기관으로 거래 관계를 판단한다", () => {
  const profile = { ...DEFAULT_PROFILE, keyAccounts: [], clients: [{ name: "조달청", count: 5 }, { name: "OO교통공사", count: 12 }] };
  const proxy = findRelation({ agency: "조달청 서울지방조달청", demandAgency: "OO재단" }, profile);
  const direct = findRelation({ agency: "OO교통공사 수도권본부", demandAgency: "" }, profile);
  assert.equal(proxy, null);
  assert.equal(direct.count, 12);
});

test("금액은 자릿수를 풀어 표기한다", () => {
  assert.equal(formatKRW(350_000_000), "3억 5,000만원");
  assert.equal(formatKRW(4_390_000_000), "43억 9,000만원");
  assert.equal(formatKRW(85_000_000), "8,500만원");
  assert.equal(formatKRW(null), "미공개");
});
