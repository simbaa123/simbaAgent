export function parseSseTextChunk(buffer) {
  const parts = buffer.split("\n\n");
  const complete = parts.slice(0, -1);
  const rest = parts.at(-1) ?? "";

  const events = [];
  for (const raw of complete) {
    const lines = raw.split("\n").filter(Boolean);
    let eventName = null;
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith("event:")) eventName = line.slice("event:".length).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
    }
    if (!eventName) continue;
    const dataText = dataLines.join("\n");
    try {
      const payload = JSON.parse(dataText);
      events.push({ event: eventName, data: payload });
    } catch {
      continue;
    }
  }
  return { events, rest };
}

