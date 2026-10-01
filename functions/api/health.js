import { json } from "../../lib/http.js";

// 화면이 어떤 모드(실데이터·데모, AI 분석 가능 여부)로 동작할지 판단하는 데 쓴다.
export async function onRequestGet({ env }) {
  return json({
    g2b: Boolean(env.G2B_SERVICE_KEY),
    ai: Boolean(env.ANTHROPIC_API_KEY),
    accessCodeRequired: Boolean(env.ACCESS_CODE),
  });
}
