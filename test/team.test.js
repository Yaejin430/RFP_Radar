import { test } from "node:test";
import assert from "node:assert/strict";
import { rowsToRecords, buildTeamProfile, buildHistoryIndex, similarProjects, tokenize } from "../public/js/team.js";
import { DEFAULT_PROFILE, scoreBid } from "../public/js/scoring.js";

// 가상 실적(테스트용)
const ROWS = [
  [],
  ["", "", "", ""],
  ["", "등록월", "적요", "거래처", "시작일", "종료일", "계약금액"],
  ["", "202201", "2022회계연도 국가회계 재무결산 용역", "OO부", "", "", "150000000"],
  ["", "202301", "2023회계연도 국가회계 재무결산 용역", "OO부", "", "", "160000000"],
  ["", "202302", "OO공사 중장기 경영전략 수립", "OO공사(주)", "", "", "250000000"],
  ["", "202402", "OO단지 투자유치 지원", "OO항만공사", "", "", "90000000"],
  ["", "202403", "OO공사 조직진단 컨설팅", "OO공사(주)", "", "", "60000000"],
];

test("머리글이 첫 줄이 아니어도 실적 열을 찾는다", () => {
  const records = rowsToRecords(ROWS);
  assert.equal(records.length, 5);
  assert.deepEqual(records[0], { title: "2022회계연도 국가회계 재무결산 용역", client: "OO부", year: "2022", amount: 150000000 });
});

test("과업명 열이 없으면 알기 쉬운 오류를 낸다", () => {
  assert.throws(() => rowsToRecords([["a", "b"], ["1", "2"]]), /과업명 열/);
});

test("팀 프로필은 거래처별 건수와 법인 표기를 정리해 집계한다", () => {
  const team = buildTeamProfile(rowsToRecords(ROWS), DEFAULT_PROFILE);
  const client = team.profile.clients.find((c) => c.name === "OO공사");
  assert.equal(client.count, 2);
  assert.equal(team.summary.records, 5);
  assert.ok(team.profile.practices.every((p) => [1, 0.7, 0.4].includes(p.weight)));
});

test("띄어쓰기가 달라도 비슷한 과거 과업을 찾는다", () => {
  const index = buildHistoryIndex(rowsToRecords(ROWS));
  const top = similarProjects("2026회계연도 OO기금 재무결산 지원", index, 1)[0];
  assert.match(top.title, /재무결산/);
  assert.ok(tokenize("중장기경영전략").has("§경영"));
});

test("실적을 반영하면 유사 실적과 거래 관계 점수가 생긴다", () => {
  const team = buildTeamProfile(rowsToRecords(ROWS), DEFAULT_PROFILE);
  const index = buildHistoryIndex(team.history);
  const s = scoreBid(
    { title: "OO공사 중장기 경영전략 재수립", agency: "OO공사", demandAgency: "", awardMethod: "협상", budget: 200000000, closeAt: null, attachments: [] },
    team.profile,
    new Date(),
    index
  );
  assert.ok(s.breakdown.similarity > 0);
  assert.ok(s.breakdown.relation > 0);
  assert.equal(s.similar[0].title, "OO공사 중장기 경영전략 수립");
});
