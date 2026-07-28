// GitHub の Contributions カレンダーとほぼ同じ見た目の SVG を生成する。
// 月ラベル・曜日ラベル・凡例・日付ツールチップ付き。light / dark の 2 枚を出力。
// カレンダー上をヘビが蛇行して進み、通過したマスを食べる SMIL アニメーション入り。

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const USER = process.env.GH_USER;
const TOKEN = process.env.GH_TOKEN;
const OUT_DIR = process.env.OUT_DIR ?? "dist";

if (!USER || !TOKEN) {
  console.error("GH_USER と GH_TOKEN が必要です");
  process.exit(1);
}

const THEMES = {
  light: {
    text: "#57606a",
    title: "#1f2328",
    border: "#d1d9e0",
    bg: "#ffffff",
    cellBorder: "rgba(27,31,35,0.06)",
    levels: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
    snake: "#6e5494",
  },
  dark: {
    text: "#9198a1",
    title: "#f0f6fc",
    border: "#3d444d",
    bg: "#0d1117",
    cellBorder: "rgba(240,246,252,0.1)",
    levels: ["#151b23", "#033a16", "#196c2e", "#2ea043", "#56d364"],
    snake: "#a371f7",
  },
};

const LEVEL_OF = {
  NONE: 0,
  FIRST_QUARTILE: 1,
  SECOND_QUARTILE: 2,
  THIRD_QUARTILE: 3,
  FOURTH_QUARTILE: 4,
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// レイアウト（GitHub 実物に合わせた寸法）
const CELL = 11;
const GAP = 3;
const STEP = CELL + GAP;
const PAD = 16;
const LABEL_W = 30; // 曜日ラベル列
const MONTH_H = 15; // 月ラベル行
const HEAD_H = 26; // 「N contributions in the last year」
const LEGEND_H = 26;

// アニメーション
const STEP_SEC = 0.09; // 1 マス進むのにかかる秒数
const SNAKE_LEN = 5; // ヘビの長さ（マス）
const TAIL_STEPS = 10; // 食べ終わったあと画面外へ抜けるぶん

async function fetchCalendar() {
  const query = `
    query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                date
                contributionCount
                contributionLevel
              }
            }
          }
        }
      }
    }`;

  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "contribution-calendar",
    },
    body: JSON.stringify({ query, variables: { login: USER } }),
  });

  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data.user.contributionsCollection.contributionCalendar;
}

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function render(calendar, theme) {
  const t = THEMES[theme];
  const weeks = calendar.weeks;

  const gridW = weeks.length * STEP - GAP;
  const gridH = 7 * STEP - GAP;
  const width = PAD * 2 + LABEL_W + gridW;
  const height = PAD * 2 + HEAD_H + MONTH_H + gridH + LEGEND_H;

  const gridX = PAD + LABEL_W;
  const gridY = PAD + HEAD_H + MONTH_H;

  const parts = [];

  // 見出し（年つき）
  const days = weeks.flatMap((w) => w.contributionDays);
  const first = new Date(`${days[0].date}T00:00:00Z`);
  const last = new Date(`${days[days.length - 1].date}T00:00:00Z`);
  const range = `${MONTHS_FULL[first.getUTCMonth()]} ${first.getUTCDate()}, ${first.getUTCFullYear()} – ${
    MONTHS_FULL[last.getUTCMonth()]
  } ${last.getUTCDate()}, ${last.getUTCFullYear()}`;

  parts.push(
    `<text x="${PAD}" y="${PAD + 13}" class="title">My contributions</text>`,
    `<text x="${width - PAD}" y="${PAD + 13}" class="lbl" text-anchor="end">${esc(range)}</text>`
  );

  // 月ラベル（その月が最初に現れる週の位置に置く。年が変わる週には年も添える）
  let prevMonth = -1;
  let prevYear = -1;
  weeks.forEach((week, wi) => {
    const d = new Date(`${week.contributionDays[0].date}T00:00:00Z`);
    const m = d.getUTCMonth();
    const y = d.getUTCFullYear();
    if (m === prevMonth) return;
    // 直前の月ラベルと近すぎる場合（週が 1 本しかない端）はスキップ
    if (wi > 0 && wi < weeks.length - 1) {
      const label = prevYear !== -1 && y !== prevYear ? `${MONTHS[m]} ${y}` : MONTHS[m];
      parts.push(
        `<text x="${gridX + wi * STEP}" y="${gridY - 5}" class="lbl">${label}</text>`
      );
      prevYear = y;
    } else if (wi === 0) {
      prevYear = y;
    }
    prevMonth = m;
  });

  // 曜日ラベル（GitHub と同じく Mon / Wed / Fri のみ）
  [[1, "Mon"], [3, "Wed"], [5, "Fri"]].forEach(([row, name]) => {
    parts.push(
      `<text x="${gridX - 6}" y="${gridY + row * STEP + CELL - 2}" class="lbl" text-anchor="end">${name}</text>`
    );
  });

  // ヘビの通り道（左から右へ、列ごとに上下を折り返す蛇行）
  const order = new Map(); // "wi:row" -> 通過順
  const pathPoints = [];
  weeks.forEach((_, wi) => {
    for (let r = 0; r < 7; r++) {
      const row = wi % 2 === 0 ? r : 6 - r;
      order.set(`${wi}:${row}`, pathPoints.length);
      pathPoints.push([gridX + wi * STEP + CELL / 2, gridY + row * STEP + CELL / 2]);
    }
  });
  const lastRow = (weeks.length - 1) % 2 === 0 ? 6 : 0;
  for (let i = 1; i <= TAIL_STEPS; i++) {
    pathPoints.push([gridX + (weeks.length - 1 + i) * STEP + CELL / 2, gridY + lastRow * STEP + CELL / 2]);
  }
  const segments = pathPoints.length - 1;
  const dur = (segments * STEP_SEC).toFixed(2);
  const clamp01 = (v) => Math.min(0.999, Math.max(0.001, v));

  // セル本体（ヘビが通過した瞬間に空マスへ変わる）
  weeks.forEach((week, wi) => {
    week.contributionDays.forEach((day) => {
      const d = new Date(`${day.date}T00:00:00Z`);
      const row = d.getUTCDay();
      const n = day.contributionCount;
      const level = LEVEL_OF[day.contributionLevel] ?? 0;
      const tip = `${n === 0 ? "No contributions" : `${n} contribution${n === 1 ? "" : "s"}`} on ${
        MONTHS_FULL[d.getUTCMonth()]
      } ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
      const eatAt = clamp01(order.get(`${wi}:${row}`) / segments).toFixed(5);
      const anim =
        level === 0
          ? ""
          : `<animate attributeName="fill" calcMode="discrete" dur="${dur}s" repeatCount="indefinite" ` +
            `values="${t.levels[level]};${t.levels[0]}" keyTimes="0;${eatAt}"/>`;
      parts.push(
        `<rect x="${gridX + wi * STEP}" y="${gridY + row * STEP}" width="${CELL}" height="${CELL}" rx="2" ry="2" ` +
          `fill="${t.levels[level]}" stroke="${t.cellBorder}">` +
          `<title>${esc(tip)}</title>${anim}</rect>`
      );
    });
  });

  // ヘビ本体
  // mpath 参照は img として読み込まれた SVG で無視される環境があるため、
  // animateMotion に path を直接持たせる。さらに始点基準の相対パスにして、
  // 万一アニメーションが効かなくても正しい位置に描画されるようにする。
  const [ox, oy] = pathPoints[0];
  const pathD = `M${pathPoints.map(([x, y]) => `${(x - ox).toFixed(1)},${(y - oy).toFixed(1)}`).join("L")}`;
  for (let i = 0; i < SNAKE_LEN; i++) {
    const size = CELL + 1 - i * 0.8;
    // 先頭ほど負の begin が大きい ＝ 先行して進む
    const begin = (-(SNAKE_LEN - i) * STEP_SEC).toFixed(3);
    parts.push(
      `<rect x="${(ox - size / 2).toFixed(2)}" y="${(oy - size / 2).toFixed(2)}" width="${size.toFixed(
        2
      )}" height="${size.toFixed(2)}" rx="${(size / 3).toFixed(2)}" fill="${t.snake}" opacity="${(
        1 -
        i * 0.12
      ).toFixed(2)}">` +
        `<animateMotion dur="${dur}s" begin="${begin}s" repeatCount="indefinite" calcMode="linear" path="${pathD}"/>` +
        `</rect>`
    );
  }

  // 凡例
  const legendY = gridY + gridH + 18;
  const legendW = 5 * STEP - GAP;
  const moreX = width - PAD;
  const boxX = moreX - 34 - legendW;
  parts.push(`<text x="${boxX - 6}" y="${legendY + 9}" class="lbl" text-anchor="end">Less</text>`);
  t.levels.forEach((c, i) => {
    parts.push(
      `<rect x="${boxX + i * STEP}" y="${legendY}" width="${CELL}" height="${CELL}" rx="2" ry="2" fill="${c}" stroke="${t.cellBorder}"/>`
    );
  });
  parts.push(`<text x="${moreX}" y="${legendY + 9}" class="lbl" text-anchor="end">More</text>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="My contributions">
  <style>
    .lbl { font: 400 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; fill: ${t.text}; }
    .title { font: 600 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; fill: ${t.title}; }
  </style>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="6" ry="6" fill="${t.bg}" stroke="${t.border}"/>
${parts.map((p) => `  ${p}`).join("\n")}
</svg>
`;
}

const calendar = await fetchCalendar();
for (const theme of ["light", "dark"]) {
  const path = `${OUT_DIR}/contribution-calendar${theme === "dark" ? "-dark" : ""}.svg`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, render(calendar, theme), "utf8");
  console.log(`wrote ${path}`);
}
