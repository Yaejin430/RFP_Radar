import Anthropic from "@anthropic-ai/sdk";
import { ANALYSIS_SCHEMA, SYSTEM_PROMPT, buildUserText } from "../../lib/analysis.js";
import { json } from "../../lib/http.js";

const MAX_RFP_CHARS = 60000;
const MAX_PDF_BYTES = 15 * 1024 * 1024;

// POST /api/analyze  { bid, profile, score, rfpText?, pdfUrl? }
export async function onRequestPost({ request, env }) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "ANTHROPIC_API_KEY 가 설정되지 않았습니다.", code: "NO_AI_KEY" }, 503);
  }
  // 공개 배포 시 API 비용이 무단으로 나가지 않도록 접근 코드를 요구할 수 있다.
  if (env.ACCESS_CODE && request.headers.get("x-access-code") !== env.ACCESS_CODE) {
    return json({ error: "접근 코드가 올바르지 않습니다.", code: "FORBIDDEN" }, 401);
  }

  const body = await request.json().catch(() => null);
  const bid = body?.bid;
  if (!bid || typeof bid.title !== "string" || !bid.title) {
    return json({ error: "공고 정보(bid)가 필요합니다.", code: "BAD_REQUEST" }, 400);
  }
  const rfpText = String(body.rfpText || "").slice(0, MAX_RFP_CHARS);

  let pdf = null;
  let pdfNote = null;
  if (body.pdfUrl) {
    try {
      pdf = await fetchG2bPdf(String(body.pdfUrl));
    } catch (err) {
      pdfNote = `첨부 PDF를 불러오지 못해 공고 정보만으로 분석했습니다. (${err.message})`;
    }
  }

  const content = [];
  if (pdf) {
    content.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: pdf.base64 },
      title: pdf.name,
    });
  }
  content.push({
    type: "text",
    text: buildUserText({ bid, profile: body.profile, score: body.score, rfpText, hasPdf: Boolean(pdf) }),
  });

  // ANTHROPIC_BASE_URL 은 Cloudflare AI Gateway 같은 프록시를 거칠 때만 설정한다.
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL || undefined });

  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM_PROMPT,
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: ANALYSIS_SCHEMA },
      },
      messages: [{ role: "user", content }],
    });

    if (response.stop_reason === "refusal") {
      return json({ error: "모델이 이 요청의 분석을 거절했습니다.", code: "REFUSAL" }, 422);
    }
    if (response.stop_reason === "max_tokens") {
      return json({ error: "분석 결과가 너무 길어 중간에 끊겼습니다.", code: "TRUNCATED" }, 502);
    }

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    const analysis = JSON.parse(text);

    return json({
      analysis,
      model: response.model,
      usage: {
        input_tokens: response.usage?.input_tokens ?? null,
        output_tokens: response.usage?.output_tokens ?? null,
      },
      sources: { pdf: pdf ? pdf.name : null, rfpText: Boolean(rfpText), note: pdfNote },
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return json({ error: "AI 호출 한도를 초과했습니다. 잠시 후 다시 시도하십시오.", code: "RATE_LIMIT" }, 429);
    }
    if (err instanceof Anthropic.AuthenticationError) {
      return json({ error: "ANTHROPIC_API_KEY 가 유효하지 않습니다.", code: "AI_AUTH" }, 502);
    }
    if (err instanceof Anthropic.APIError) {
      return json({ error: `AI 호출 오류: ${err.message}`, code: "AI_ERROR" }, 502);
    }
    if (err instanceof SyntaxError) {
      return json({ error: "AI 응답을 해석하지 못했습니다.", code: "AI_PARSE" }, 502);
    }
    return json({ error: err.message || "알 수 없는 오류", code: "INTERNAL" }, 500);
  }
}

// 나라장터 첨부파일만 허용한다(임의 URL 요청 차단).
async function fetchG2bPdf(rawUrl) {
  const url = new URL(rawUrl);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("허용되지 않은 주소");
  if (host !== "g2b.go.kr" && !host.endsWith(".g2b.go.kr")) throw new Error("나라장터 주소가 아님");

  const res = await fetch(url.toString(), { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_PDF_BYTES) throw new Error("파일이 15MB를 넘음");
  const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  if (String.fromCharCode(...head) !== "%PDF") throw new Error("PDF 형식이 아님");

  const disposition = res.headers.get("content-disposition") || "";
  const nameMatch = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  const name = nameMatch ? safeDecode(nameMatch[1]) : "첨부 문서.pdf";
  return { name, base64: toBase64(buf) };
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
