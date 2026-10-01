// Claude 에게 보낼 제안 전략 분석 프롬프트와 응답 스키마.

export const ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "client_intent",
    "fit_assessment",
    "win_themes",
    "proposal_outline",
    "required_experts",
    "risks",
    "clarification_questions",
    "go_no_go",
  ],
  properties: {
    summary: { type: "string", description: "과업 요약, 3~4문장" },
    client_intent: {
      type: "array",
      description: "발주처가 이 과업으로 해결하려는 정책 문제와 기대 산출물",
      items: { type: "string" },
    },
    fit_assessment: { type: "string", description: "우리 회사 역량 프로필과의 적합도 평가" },
    win_themes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "detail"],
        properties: { title: { type: "string" }, detail: { type: "string" } },
      },
    },
    proposal_outline: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["section", "key_message"],
        properties: { section: { type: "string" }, key_message: { type: "string" } },
      },
    },
    required_experts: { type: "array", items: { type: "string" } },
    risks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["risk", "mitigation"],
        properties: { risk: { type: "string" }, mitigation: { type: "string" } },
      },
    },
    clarification_questions: { type: "array", items: { type: "string" } },
    go_no_go: {
      type: "object",
      additionalProperties: false,
      required: ["decision", "rationale"],
      properties: {
        decision: { type: "string", enum: ["GO", "CONDITIONAL", "NO_GO"] },
        rationale: { type: "string" },
      },
    },
  },
};

export const SYSTEM_PROMPT = `당신은 한국 공공부문 컨설팅 회사의 제안 전략 책임자입니다. 나라장터 용역 공고를 검토해 우리 회사가 입찰에 참여할지 판단하고, 참여한다면 어떻게 수주할지 제안 착수 메모를 작성합니다.

작성 원칙:
- 공고 정보와 첨부 자료에 적힌 사실만 근거로 삼습니다. 공고에 없는 예산, 일정, 평가 배점, 과업 범위를 지어내지 않습니다. 정보가 부족하면 "공고문만으로는 확인되지 않음"이라고 적고 확인 방법을 함께 제시합니다.
- 발주처가 이 과업으로 해결하려는 정책 문제를 먼저 파악한 뒤 수주 전략을 세웁니다. 일반론보다 이 공고에만 해당하는 내용을 우선합니다.
- 제안서 목차는 공공 연구용역 제안서의 관행(사업 이해, 수행 방법론, 추진 일정, 투입 인력, 관리 방안)을 따르되, 핵심 메시지는 이 과업에 맞게 구체적으로 씁니다.
- 한국어 완결형 문장으로 씁니다. 대시(—, –)를 문장부호로 쓰지 않습니다. 근거 없는 수식어("획기적인", "막대한")를 쓰지 않습니다.
- 금액은 "3억 5,000만원"처럼 자릿수를 풀어 씁니다.
- 참여 판단(go_no_go)은 GO, CONDITIONAL, NO_GO 중 하나로 정하고, 판단 근거를 두세 문장으로 밝힙니다.`;

export function buildUserText({ bid, profile, score, rfpText, hasPdf }) {
  const facts = {
    공고번호: `${bid.no}-${bid.ord}`,
    공고명: bid.title,
    공고기관: bid.agency,
    수요기관: bid.demandAgency,
    공고종류: bid.kind,
    계약방법: bid.contractMethod,
    낙찰방법: bid.awardMethod,
    게시일시: bid.postedAt,
    입찰마감일시: bid.closeAt,
    개찰일시: bid.openAt,
    배정예산_원: bid.budget,
    추정가격_원: bid.estPrice,
    첨부파일: (bid.attachments || []).map((a) => a.name),
  };

  const lines = [
    "## 공고 정보 (나라장터 Open API)",
    "```json",
    JSON.stringify(facts, null, 2),
    "```",
    "",
    "## 우리 회사 역량 프로필",
    `- 프로필 이름: ${profile?.name || "미지정"}`,
    `- 주력 분야: ${(profile?.practices || []).map((p) => p.label).join(", ") || "미지정"}`,
    `- 핵심 발주처: ${(profile?.keyAccounts || []).join(", ") || "미지정"}`,
  ];

  if (score) {
    lines.push(
      "",
      "## 규칙 기반 적합도 점수 (참고용)",
      `- 총점 ${score.score}점, 등급 ${score.grade}`,
      ...(score.reasons || []).map((r) => `- ${r}`)
    );
  }

  if (rfpText) {
    lines.push("", "## 제안요청서·과업지시서 본문 (사용자 제공)", rfpText);
  }
  if (hasPdf) {
    lines.push("", "첨부된 PDF 문서는 이 공고의 첨부파일입니다. 과업 범위와 평가 기준은 이 문서를 우선 근거로 삼으십시오.");
  }
  if (!rfpText && !hasPdf) {
    lines.push(
      "",
      "제안요청서 본문은 제공되지 않았습니다. 공고명과 공고 정보만으로 판단하고, 본문 확인이 필요한 항목은 명시하십시오."
    );
  }

  lines.push("", "위 자료로 입찰 참여 판단과 제안 착수 메모를 작성하십시오.");
  return lines.join("\n");
}
