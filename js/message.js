// The shareable-message template. Edit the strings below to change the
// wording — nothing else in the app depends on the exact format.

const MEDALS = { 1: "🥇", 2: "🥈", 3: "🥉" };

export function buildMessage(week, winners) {
  // winners: [{rank, name, reason, video_url}] sorted by rank
  const lines = [];
  lines.push(`🏆 *${week} — Top 3 Projects* 🏆`);
  lines.push("");

  for (const w of winners) {
    lines.push(`${MEDALS[w.rank]} *#${w.rank} ${w.name}*`);
    if (w.reason) lines.push(w.reason.trim());
    lines.push(`▶ ${w.video_url}`);
    lines.push("");
  }

  lines.push("Congratulations to the winners — keep pushing, everyone! 👏🔥");
  return lines.join("\n");
}
