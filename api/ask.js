// Vercel serverless function: /api/ask
// Keeps the Anthropic API key server-side. Never expose it in frontend code.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY. Set it in your Vercel project's Environment Variables." });
    return;
  }

  const { question, sections, payMatches } = req.body || {};
  if (!question || !Array.isArray(sections)) {
    res.status(400).json({ error: "Request must include 'question' and 'sections'." });
    return;
  }

  const context = sections
    .map((s) => `[Section ${s.id} — ${s.title}]\n${s.text}`)
    .join("\n\n---\n\n");

  const payContext =
    Array.isArray(payMatches) && payMatches.length > 0
      ? payMatches
          .map(
            (p) =>
              `[Pay scale reference — ${p.title}]\nRange: ${p.range}\nNote: ${p.note}\nSource: ${p.source} (${p.as_of})`
          )
          .join("\n\n---\n\n")
      : "";

  const systemPrompt = `You are a research assistant answering questions about the CCPOA Bargaining Unit 6 Memorandum of Understanding (MOU) between the State of California and CCPOA, effective July 3, 2025 through July 2, 2028.

Answer using the MOU excerpts and, when provided, the pay scale reference data below. Always cite the specific section number(s) for anything drawn from the MOU, like "Per Section 6.13 (Mini-Arb)...". These two sources are DIFFERENT: the MOU excerpts are the actual contract text; the pay scale reference is separate CalHR/CDCR data on dollar figures, since the MOU itself sets salary range structure (steps, differentials) rather than dollar tables. NEVER blend them without saying so — if you use pay scale reference data, say plainly that the figure comes from CalHR/CDCR's published pay scale, not the MOU text itself, and flag if the source date might predate a GSI increase mentioned in the MOU.

If neither source contains the answer, say so in one direct sentence — don't hedge or pad it out. Be precise about numbers, deadlines, and procedures. Keep answers concise and direct.

MOU EXCERPTS:
${context}${payContext ? `

PAY SCALE REFERENCE (external to MOU, from CalHR/CDCR):
${payContext}` : ""}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: "user", content: question }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      res.status(response.status).json({ error: `Anthropic API error: ${errText}` });
      return;
    }

    const data = await response.json();
    const textBlocks = (data.content || []).filter((b) => b.type === "text").map((b) => b.text);
    res.status(200).json({ answer: textBlocks.join("\n") || "No response received." });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
