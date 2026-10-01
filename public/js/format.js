// 금액은 자릿수를 풀어 쓴다: 350000000 -> "3억 5,000만원"
export function formatKRW(amount) {
  if (amount == null || !Number.isFinite(amount)) return "미공개";
  const eok = Math.floor(amount / 1e8);
  const man = Math.floor((amount % 1e8) / 1e4);
  const parts = [];
  if (eok) parts.push(`${eok.toLocaleString("ko-KR")}억`);
  if (man) parts.push(`${man.toLocaleString("ko-KR")}만`);
  if (!parts.length) return `${Math.round(amount).toLocaleString("ko-KR")}원`;
  return `${parts.join(" ")}원`;
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

// ISO -> "9월 30일(수) 10:00" (KST 기준)
export function formatDateTime(iso, { time = true } = {}) {
  if (!iso) return "미정";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "미정";
  const k = new Date(d.getTime() + 9 * 3600e3);
  const base = `${k.getUTCMonth() + 1}월 ${k.getUTCDate()}일(${WEEKDAYS[k.getUTCDay()]})`;
  if (!time) return base;
  const hh = String(k.getUTCHours()).padStart(2, "0");
  const mm = String(k.getUTCMinutes()).padStart(2, "0");
  return `${base} ${hh}:${mm}`;
}

export function dDayLabel(daysLeft) {
  if (daysLeft == null) return "마감일 미정";
  if (daysLeft < 0) return "마감";
  const d = Math.floor(daysLeft);
  return d === 0 ? "D-Day" : `D-${d}`;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
