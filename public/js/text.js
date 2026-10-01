// 영문 약어(AI, ISP 등)는 단어 경계로, 한글은 부분 일치로 찾는다.
export function hasKeyword(text, keyword) {
  if (!keyword) return false;
  if (/^[A-Za-z0-9&]+$/.test(keyword)) {
    const escaped = keyword.replace(/[&]/g, "\\&");
    return new RegExp(`(^|[^A-Za-z])${escaped}([^A-Za-z]|$)`, "i").test(text);
  }
  return text.includes(keyword);
}

// 기관명 비교용: 법인 표기와 공백을 없앤다. "OO발전(주)" -> "OO발전"
export function normalizeOrg(name) {
  return String(name || "")
    .replace(/\((주|유|재|학|사|사단|재단)\)|주식회사|유한회사|재단법인|사단법인|학교법인/g, "")
    .replace(/\s+/g, "")
    .trim();
}
