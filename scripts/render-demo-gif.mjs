// Renders docs/assets/failover-demo.gif from the transcript written by
// `pnpm demo:failover --transcript docs/assets/failover-demo.txt`, so the GIF
// only ever shows real demo output. Requires Google Chrome and ffmpeg.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const transcript = resolve(process.argv[2] ?? "docs/assets/failover-demo.txt");
const output = resolve(process.argv[3] ?? "docs/assets/failover-demo.gif");
const chrome = process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const lines = readFileSync(transcript, "utf8").trimEnd().split("\n");
const width = 1000;
const lineHeight = 30;
const height = 70 + lines.length * lineHeight + 30;
const work = mkdtempSync(join(tmpdir(), "failover-gif-"));

try {
  // One frame per revealed line, plus a final hold frame.
  for (let shown = 1; shown <= lines.length; shown += 1) {
    const html = join(work, "frame.html");
    writeFileSync(html, page(lines.slice(0, shown)));
    execFileSync(chrome, [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      `--window-size=${width},${height}`,
      `--screenshot=${join(work, `frame-${String(shown).padStart(3, "0")}.png`)}`,
      `file://${html}`,
    ], { stdio: "ignore" });
  }

  const list = [];
  for (let shown = 1; shown <= lines.length; shown += 1) {
    const isLast = shown === lines.length;
    const isBreak = lines[shown] === "";
    list.push(`file 'frame-${String(shown).padStart(3, "0")}.png'`);
    list.push(`duration ${isLast ? 4 : isBreak ? 1.2 : 0.45}`);
  }
  // The concat demuxer ignores the last duration unless the file repeats.
  list.push(`file 'frame-${String(lines.length).padStart(3, "0")}.png'`);
  writeFileSync(join(work, "frames.txt"), `${list.join("\n")}\n`);

  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", join(work, "frames.txt"),
    "-vf", "split[a][b];[a]palettegen=max_colors=32[p];[b][p]paletteuse=dither=none",
    "-loop", "0",
    output,
  ], { stdio: "inherit" });
  console.log(`Wrote ${output} (${lines.length} lines)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

function page(shown) {
  const body = shown.map((line) => `<div class="${kind(line)}">${escape(line) || "&nbsp;"}</div>`).join("");
  return `<!doctype html><meta charset="utf-8"><style>
    html, body { margin: 0; background: #111827; }
    body { width: ${width}px; height: ${height}px; overflow: hidden; }
    .dots { padding: 18px 24px 0; }
    .dots span { display: inline-block; width: 12px; height: 12px; border-radius: 50%; margin-right: 8px; }
    pre { margin: 22px 32px; font: 19px/${lineHeight}px Menlo, Monaco, monospace; color: #e5e7eb; }
    .head { color: #93c5fd; } .done { color: #86efac; } .error { color: #fca5a5; }
    .restart { color: #fbbf24; } .upstream { color: #6b7280; }
  </style><div class="dots"><span style="background:#f87171"></span><span style="background:#fbbf24"></span><span style="background:#34d399"></span></div><pre>${body}</pre>`;
}

function kind(line) {
  if (/^(PRE|POST)-CONTENT/.test(line)) return "head";
  if (line.startsWith("done")) return "done";
  if (line.startsWith("error")) return "error";
  if (line.startsWith("restart")) return "restart";
  if (line.trimStart().startsWith("(upstream")) return "upstream";
  return "";
}

function escape(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
