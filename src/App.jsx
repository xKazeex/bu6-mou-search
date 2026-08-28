import React, { useState, useMemo, useRef, useEffect } from "react";
import { MOU_SECTIONS } from "./data/mouSections";
import { PAY_SCALES } from "./data/payScales";

const MOU_META = {
  title: "CCPOA Bargaining Unit 6 MOU",
  subtitle: "State of California & California Correctional Peace Officers Association",
  term: "July 3, 2025 \u2013 July 2, 2028",
};

// ---------- Local keyword search (no embeddings, no network call needed for retrieval) ----------

const STOPWORDS = new Set([
  "a","an","the","is","are","was","were","be","been","being","to","of","in","on","for","and","or",
  "but","if","then","so","do","does","did","have","has","had","i","my","me","can","could","would",
  "should","will","shall","this","that","these","those","what","when","where","who","how","not",
  "with","as","by","from","at","it","its","their","them","they","we","our","you","your"
]);

// Common CDCR/CCPOA shorthand union reps actually type, mapped to how the MOU
// itself phrases things. Expand BEFORE tokenizing so "ccii", "cc2", "cc-2" all
// normalize to the same thing the document uses ("cc ii").
const ALIASES = [
  [/\bcc\s*-?\s*(i{1,3}|1|2|3)\b/gi, (m, n) => {
    const roman = { "1": "i", "2": "ii", "3": "iii", "i": "i", "ii": "ii", "iii": "iii" };
    return "cc " + (roman[n.toLowerCase()] || n);
  }],
  [/\bco\b/gi, "co"],
  [/\bpa\s*-?\s*(i{1,3}|1|2)\b/gi, (m, n) => {
    const roman = { "1": "i", "2": "ii", "i": "i", "ii": "ii" };
    return "pa " + (roman[n.toLowerCase()] || n);
  }],
  [/\bpsa\b/gi, "psa"],
  [/\bloi\b/gi, "letter of instruction"],
  [/\bmsa\b/gi, "merit salary adjustment"],
  [/\bidl\b/gi, "industrial disability leave"],
  [/\beidl\b/gi, "enhanced industrial disability leave"],
  [/\bcto\b/gi, "compensatory time off"],
  [/\bplp\b/gi, "personal leave program"],
  [/\brdo\b/gi, "regular day off"],
  [/\bpobr\b/gi, "peace officer bill of rights"],
  [/\bgsi\b/gi, "general salary increase"],
  [/\bcdl\b/gi, "commercial driver license"],
  // Everyday phrasing reps actually type ("pay me", "paid late") doesn't share
  // any words with how the MOU writes it ("wages", "salary advance", "payroll").
  // Append the MOU's own vocabulary alongside the original words instead of
  // replacing them, so both phrasings can match.
  [/\b(pay|paid|pays|paycheck)\b/gi, (m) => m + " wages salary payroll timely"],
];

function expandAliases(str) {
  let out = str;
  ALIASES.forEach(([pattern, replacement]) => {
    out = out.replace(pattern, replacement);
  });
  return out;
}

function tokenize(str) {
  const expanded = expandAliases(str);
  return (expanded.toLowerCase().match(/[a-z0-9.]+/g) || []).filter(
    (t) => t.length > 1 && !STOPWORDS.has(t)
  );
}

function buildIndex(sections) {
  return sections.map((s) => {
    const bodyTokens = tokenize(s.text);
    const titleTokens = tokenize(s.title);
    const freq = {};
    bodyTokens.forEach((t) => (freq[t] = (freq[t] || 0) + 1));
    titleTokens.forEach((t) => (freq[t] = (freq[t] || 0) + 3)); // title words weighted higher
    return { section: s, freq, len: bodyTokens.length + titleTokens.length };
  });
}

function scoreSections(query, index) {
  const qTokens = tokenize(query);
  // direct section-number match e.g. "6.13" or "section 6.13"
  const directMatch = query.match(/\b(\d{1,2}\.\d{1,2})\b/);

  const scored = index.map(({ section, freq, len }) => {
    let score = 0;
    qTokens.forEach((qt) => {
      if (freq[qt]) score += freq[qt] / Math.sqrt(len + 1);
      // partial/substring boost for things like "grievance" matching "grievances"
      Object.keys(freq).forEach((k) => {
        if (k !== qt && k.startsWith(qt) && qt.length > 3) {
          score += 0.3 * (freq[k] / Math.sqrt(len + 1));
        }
      });
    });
    if (directMatch && section.id === directMatch[1]) {
      score += 50; // strong boost for exact section-number reference
    }
    return { section, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
}

function matchPayScales(query) {
  const isPayQuestion = /\bpay\b|\bsalary\b|\bsalaries\b|\bmake\b|\bearn/i.test(query);
  if (!isPayQuestion) return [];
  // Reuse the same alias-expanding tokenizer as MOU search, so "ccii"/"cc2" match
  // the "(CC II Specialist)" style shorthand baked into pay scale titles.
  const qTokens = new Set(tokenize(query));
  return PAY_SCALES.filter((p) => {
    const titleTokens = tokenize(p.title);
    return titleTokens.some((t) => qTokens.has(t) && t.length > 1);
  });
}

// ---------- Claude API call ----------

async function askClaude(question, retrievedSections, payMatches) {
  const response = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question,
      sections: retrievedSections,
      payMatches: payMatches || [],
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data.answer || "No response received.";
}

// ---------- Grievance deadline calculator (Article VI) ----------

// Sections eligible for mini-arb per 6.13 A (base section numbers; some entries
// only apply to a specific lettered subsection in the MOU, e.g. "10.02 D." —
// this calculator can't see subsections, so it flags overlaps for manual check).
const MINI_ARB_BASE_SECTIONS = new Set([
  "7.01", "7.03", "8.04", "9.01", "9.02", "9.05", "10.01", "10.02", "10.06",
  "11.01", "11.03", "11.04", "11.06", "11.09", "11.12", "12.05", "12.06",
  "14.02", "14.06", "14.07", "14.08", "15.03", "15.12", "16.04", "17.01",
  "17.04", "17.07", "17.12", "19.04", "19.05", "19.07", "20.05", "20.06",
  "25.03", "25.04", "25.05", "26.02",
]);

// Sections that may go directly to arbitration after the Step 3 response,
// per 6.09 B.5 (again, base numbers — some are "except" a specific subsection).
const DIRECT_ARB_AFTER_STEP3_SECTIONS = new Set([
  "2.03", "2.04", "2.08", "2.09", "5.03", "7.04", "7.05", "7.06", "7.07",
  "9.03", "9.06", "9.09", "10.02", "10.07", "10.08", "10.16", "10.19",
  "11.02", "11.05", "12.04", "14.05", "16.02", "16.06", "17.05", "17.06",
  "17.08", "17.09", "17.11", "17.12", "17.13", "18.01", "19.01", "19.02",
  "19.03", "19.06", "19.13", "19.14", "19.15", "20.01", "20.02", "20.06",
  "20.08", "20.10", "23.01", "23.02", "25.01", "25.02",
]);

function parseLocalDate(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function addCalendarDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function addWorkDays(date, days) {
  const d = new Date(date);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) added++;
  }
  return d;
}

function formatDate(d) {
  if (!d) return null;
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function extractSectionBase(input) {
  const m = (input || "").match(/(\d{1,2})\.(\d{1,2})/);
  if (!m) return null;
  return `${parseInt(m[1], 10)}.${m[2].padStart(2, "0")}`;
}

function dayStatus(date) {
  if (!date) return "future";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cmp = new Date(date);
  cmp.setHours(0, 0, 0, 0);
  const diffDays = Math.round((cmp - today) / 86400000);
  if (diffDays < 0) return "past";
  if (diffDays <= 7) return "soon";
  return "future";
}

function buildGrievanceTimeline({ kind, incidentDate, step1Happened, step1DecisionDate, sectionInput, wardenSubmitDate }) {
  const steps = [];
  if (kind === "healthsafety") {
    steps.push({
      label: "Consult your supervisor immediately",
      citation: "6.16 B.2.a",
      date: null,
      note: "No fixed deadline — the MOU says \"immediately.\" If unresolved that shift, submit a written H&S grievance to the Warden.",
    });
    if (wardenSubmitDate) {
      const submitted = parseLocalDate(wardenSubmitDate);
      const wardenResponse = addCalendarDays(submitted, 10);
      steps.push({
        label: "Warden's response due",
        citation: "6.16 B.2.c",
        date: wardenResponse,
        note: "10 calendar days after the Warden receives your written grievance.",
      });
      steps.push({
        label: "Appeal to Associate Director due (if dissatisfied)",
        citation: "6.16 B.2.e",
        date: addCalendarDays(wardenResponse, 10),
        note: "10 calendar days after the Warden's response — assumes response arrives on the deadline above.",
      });
    } else {
      steps.push({
        label: "Warden's response due",
        citation: "6.16 B.2.c",
        date: null,
        note: "10 calendar days after the Warden receives your written grievance — enter that submission date for an exact date.",
      });
    }
    steps.push({
      label: "Associate Director's response — FINAL STEP",
      citation: "6.16 B.2.f",
      date: null,
      note: "10 calendar days after the appeal is received. This exhausts administrative remedies for the H&S aspects of the grievance. You may also file directly with Cal/OSHA at any time (6.16 C).",
      isFinal: true,
    });
    return steps;
  }

  if (kind === "drugtest") {
    const base = parseLocalDate(incidentDate);
    if (!base) return steps;
    const filingDeadline = addWorkDays(base, 10);
    const deptResponse = addWorkDays(filingDeadline, 10);
    const calhrAppeal = addWorkDays(deptResponse, 5);
    steps.push({
      label: "File expedited grievance",
      citation: "9.12 (K)(1)",
      date: filingDeadline,
      note: "10 workdays from the test date, or from discovery of the alleged procedural violation. Workdays here = Mon–Fri only; state holidays aren't accounted for.",
    });
    steps.push({
      label: "Departmental response due",
      citation: "9.12 (K)(2)",
      date: deptResponse,
      note: "10 workdays after the grievance is filed (assumes filing on the deadline above).",
    });
    steps.push({
      label: "Appeal to CalHR — FINAL STEP",
      citation: "9.12 (K)(3)",
      date: calhrAppeal,
      note: "5 workdays after receipt of the Departmental decision. This is the final step and exhausts administrative remedies for procedural non-conformance claims under 9.12.",
      isFinal: true,
    });
    return steps;
  }

  // Standard contract grievance / final-at-Step-2 grievance
  const base = parseLocalDate(incidentDate);
  if (!base) return steps;

  const step1Deadline = addCalendarDays(base, 30);
  steps.push({
    label: "Step 1 — Informal discussion deadline",
    citation: "6.07 A",
    date: step1Deadline,
    note: "Within 30 calendar days of the incident, or of when you reasonably should have known about it.",
  });

  let step2FilingDeadline, step2FilingNote;
  if (step1Happened && step1DecisionDate) {
    const step1Decision = parseLocalDate(step1DecisionDate);
    step2FilingDeadline = addCalendarDays(step1Decision, 10);
    step2FilingNote = "10 calendar days after the Step 1 decision (6.08 A).";
  } else {
    step2FilingDeadline = addCalendarDays(base, 30);
    step2FilingNote = "30 calendar days after the incident, since Step 1 wasn't used (6.08 B).";
  }
  steps.push({
    label: "Step 2 — File formal grievance",
    citation: "6.08 A/B",
    date: step2FilingDeadline,
    note: step2FilingNote,
  });

  const step2Response = addCalendarDays(step2FilingDeadline, 30);
  steps.push({
    label: "Step 2 — Hiring Authority response due",
    citation: "6.08 F",
    date: step2Response,
    note: "30 calendar days after receipt of the formal grievance (assumes filing on the deadline above).",
  });

  if (kind === "finalStep2") {
    steps.push({
      label: "Step 2 is the FINAL LEVEL for this grievance",
      citation: "6.08 H",
      date: null,
      note: "Grievances about the content of a performance appraisal, or an alleged POBR violation, stop here — no further appeal under this MOU.",
      isFinal: true,
    });
    return steps;
  }

  const sectionBase = extractSectionBase(sectionInput);
  const isMiniArb = sectionBase && MINI_ARB_BASE_SECTIONS.has(sectionBase);
  const isDirectArb = sectionBase && DIRECT_ARB_AFTER_STEP3_SECTIONS.has(sectionBase);

  if (sectionBase && isMiniArb && isDirectArb) {
    steps.push({
      label: `Section ${sectionBase} has subsection-specific rules`,
      citation: "6.09 B.5 / 6.13 A",
      date: null,
      note: "This section appears on both the mini-arb list and the direct-to-arbitration list, depending on which lettered subsection is at issue. Check the exact subsection against 6.09 B.5 and 6.13 A, or confirm with your Chief of Labor before relying on either path below.",
    });
  }

  if (sectionBase && isMiniArb && !isDirectArb) {
    const miniArbDeadline = addCalendarDays(step2Response, 100);
    steps.push({
      label: "Mini-arb request due — FINAL LEVEL",
      citation: "6.13 A / 6.13 B.6",
      date: miniArbDeadline,
      note: "100 calendar days after the Step 2 response. Mini-arb is the only and final level of review for this section.",
      isFinal: true,
    });
    return steps;
  }

  if (sectionBase && isDirectArb && !isMiniArb) {
    const step3Appeal = addCalendarDays(step2Response, 30);
    const step3Response = addCalendarDays(step3Appeal, 30);
    const arbRequest = addCalendarDays(step3Response, 30);
    steps.push({
      label: "Step 3 — Appeal to Department Director due",
      citation: "6.09 B.2.a",
      date: step3Appeal,
      note: "30 calendar days after the Step 2 response.",
    });
    steps.push({
      label: "Step 3 — Response due",
      citation: "6.09 B.2.b",
      date: step3Response,
      note: "30 calendar days after the Step 3 appeal is received.",
    });
    steps.push({
      label: "Arbitration request due — this section skips Step 4",
      citation: "6.09 B.5",
      date: arbRequest,
      note: "30 calendar days after the Step 3 response. This section is on the list that goes directly to arbitration after Step 3.",
      isFinal: true,
    });
    return steps;
  }

  // Default path: Step 3 -> Step 4 -> arbitration
  const step3Appeal = addCalendarDays(step2Response, 30);
  const step3Response = addCalendarDays(step3Appeal, 30);
  steps.push({
    label: "Step 3 — Appeal due",
    citation: "6.09",
    date: step3Appeal,
    note: sectionBase
      ? "30 calendar days after the Step 2 response. (This section isn't on the mini-arb or direct-arbitration lists, so the default Step 3 → Step 4 path applies.)"
      : "30 calendar days after the Step 2 response. Enter a section number above for a more specific path if one applies.",
  });
  steps.push({
    label: "Step 3 — Response due",
    citation: "6.09",
    date: step3Response,
    note: "30 calendar days after the Step 3 appeal is received. Some grievances (Health & Safety, LOI content, policy grievances) are final here per 6.09 B.3.",
  });
  const step4Appeal = addCalendarDays(step3Response, 30);
  const step4Response = addCalendarDays(step4Appeal, 30);
  steps.push({
    label: "Step 4 — Appeal to CalHR due",
    citation: "6.10",
    date: step4Appeal,
    note: "30 calendar days after the Step 3 response.",
  });
  steps.push({
    label: "Step 4 — Response due",
    citation: "6.10",
    date: step4Response,
    note: "30 calendar days after the Step 4 appeal is received.",
  });
  const arbRequest = addCalendarDays(step4Response, 30);
  steps.push({
    label: "Arbitration demand due — FINAL LEVEL",
    citation: "6.11 A/B",
    date: arbRequest,
    note: "30 calendar days after the Step 4 response. Only CCPOA (not an individual grievant) may appeal to binding arbitration. Once appealed, CCPOA then has 180 calendar days to request striking arbitrators (6.11 B) or the grievance is considered withdrawn.",
    isFinal: true,
  });
  return steps;
}

function DeadlineCalculator() {
  const [kind, setKind] = useState("standard");
  const [incidentDate, setIncidentDate] = useState("");
  const [sectionInput, setSectionInput] = useState("");
  const [step1Happened, setStep1Happened] = useState(false);
  const [step1DecisionDate, setStep1DecisionDate] = useState("");
  const [wardenSubmitDate, setWardenSubmitDate] = useState("");

  const kindOptions = [
    { id: "standard", label: "Standard contract grievance" },
    { id: "finalStep2", label: "Performance appraisal content or POBR violation" },
    { id: "healthsafety", label: "Health & Safety grievance (6.16)" },
    { id: "drugtest", label: "Drug/alcohol testing procedure (9.12 expedited)" },
  ];

  const steps = useMemo(
    () =>
      buildGrievanceTimeline({
        kind,
        incidentDate,
        step1Happened,
        step1DecisionDate,
        sectionInput,
        wardenSubmitDate,
      }),
    [kind, incidentDate, step1Happened, step1DecisionDate, sectionInput, wardenSubmitDate]
  );

  const inputStyle = {
    width: "100%",
    padding: "9px 11px",
    borderRadius: 8,
    border: "1px solid #C8C0AF",
    fontSize: 14,
    fontFamily: "inherit",
    background: "#fff",
  };
  const labelStyle = {
    display: "block",
    fontSize: 12.5,
    fontWeight: 600,
    color: "#3A4750",
    marginBottom: 4,
  };

  return (
    <div style={{ maxWidth: 880, margin: "0 auto", padding: "24px" }}>
      <div
        style={{
          background: "#EFE6D0",
          border: "1px solid #D9CBA3",
          borderRadius: 8,
          padding: "12px 16px",
          fontSize: 13,
          color: "#5C4A1E",
          marginBottom: 20,
          lineHeight: 1.5,
        }}
      >
        This is a guide based on the calendar-day and workday rules in Article VI and related
        sections. It doesn't account for mutually agreed time extensions (6.03), frozen grievance
        periods for mass/frivolous grievances, or every lettered-subsection exception. Confirm
        anything time-sensitive with your Chapter President or the CCPOA Chief of Labor.
      </div>

      <div style={{ marginBottom: 18 }}>
        <label style={labelStyle}>What kind of grievance is this?</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {kindOptions.map((k) => (
            <button
              key={k.id}
              onClick={() => setKind(k.id)}
              style={{
                textAlign: "left",
                background: kind === k.id ? "#16506E" : "#FFFFFF",
                color: kind === k.id ? "#fff" : "#3A4750",
                border: "1px solid " + (kind === k.id ? "#16506E" : "#D9D2C0"),
                borderRadius: 8,
                padding: "8px 12px",
                fontSize: 13,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {k.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 8 }}>
        <div>
          <label style={labelStyle}>
            {kind === "healthsafety"
              ? "Date the H&S issue arose"
              : kind === "drugtest"
              ? "Date of the test or discovery of the violation"
              : "Date of the incident (or when you reasonably knew)"}
          </label>
          <input
            type="date"
            value={incidentDate}
            onChange={(e) => setIncidentDate(e.target.value)}
            style={inputStyle}
          />
        </div>
        {kind === "standard" && (
          <div>
            <label style={labelStyle}>MOU section at issue (optional)</label>
            <input
              type="text"
              placeholder="e.g. 6.13 or 10.10"
              value={sectionInput}
              onChange={(e) => setSectionInput(e.target.value)}
              style={inputStyle}
            />
          </div>
        )}
        {kind === "healthsafety" && (
          <div>
            <label style={labelStyle}>Date submitted to Warden (optional)</label>
            <input
              type="date"
              value={wardenSubmitDate}
              onChange={(e) => setWardenSubmitDate(e.target.value)}
              style={inputStyle}
            />
          </div>
        )}
      </div>

      {kind === "standard" && (
        <div style={{ marginBottom: 18 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#3A4750", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={step1Happened}
              onChange={(e) => setStep1Happened(e.target.checked)}
            />
            Step 1 (informal discussion) already happened
          </label>
          {step1Happened && (
            <div style={{ marginTop: 8, maxWidth: 260 }}>
              <label style={labelStyle}>Date of the Step 1 decision</label>
              <input
                type="date"
                value={step1DecisionDate}
                onChange={(e) => setStep1DecisionDate(e.target.value)}
                style={inputStyle}
              />
            </div>
          )}
        </div>
      )}

      {steps.length === 0 ? (
        <div style={{ fontSize: 13.5, color: "#8A8477", padding: "20px 0" }}>
          Enter a date above to see the deadline timeline.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {steps.map((s, i) => {
            const status = dayStatus(s.date);
            const dotColor = s.isFinal ? "#8A3B2E" : status === "past" ? "#8A3B2E" : status === "soon" ? "#B8860B" : "#16506E";
            return (
              <div
                key={i}
                style={{
                  background: "#FFFFFF",
                  border: "1px solid #E3DCC9",
                  borderLeft: `4px solid ${dotColor}`,
                  borderRadius: 8,
                  padding: "12px 16px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
                  <div
                    style={{
                      fontFamily: "'IBM Plex Serif', serif",
                      fontWeight: 600,
                      fontSize: 14.5,
                      color: "#1C2B33",
                    }}
                  >
                    {s.label}
                  </div>
                  <div
                    style={{
                      fontFamily: "'IBM Plex Mono', monospace",
                      fontSize: 12.5,
                      color: dotColor,
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {s.date ? formatDate(s.date) : "See note"}
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "#8A8477", marginTop: 2, fontFamily: "'IBM Plex Mono', monospace" }}>
                  § {s.citation}
                </div>
                <div style={{ fontSize: 13, color: "#5C6169", marginTop: 6, lineHeight: 1.5 }}>{s.note}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------- UI ----------

const SUGGESTED_QUESTIONS = [
  "What is the general salary increase for 2025 and 2027?",
  "How many vacation days do I accrue?",
  "What's the grievance timeline for Step 2?",
  "What is the night shift differential?",
  "How does the Personal Leave Program 2025 work?",
  "What happens in a mini-arb?",
];

export default function MOUSearchApp() {
  const [activeTab, setActiveTab] = useState("ask");
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [expandedSections, setExpandedSections] = useState({});
  const scrollRef = useRef(null);

  const index = useMemo(() => buildIndex(MOU_SECTIONS), []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  async function handleAsk(q) {
    const question = (q || query).trim();
    if (!question || loading) return;
    setQuery("");
    setLoading(true);

    const scored = scoreSections(question, index);
    const top = scored.slice(0, 7).map((s) => s.section);
    const payMatches = matchPayScales(question);

    setMessages((prev) => [...prev, { role: "user", text: question }]);

    if (top.length === 0 && payMatches.length === 0) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: "I couldn't find anything in the MOU or the pay scale reference related to that question. Try rephrasing, or ask about a specific article, section number, or classification.",
          sources: [],
          payMatches: [],
        },
      ]);
      setLoading(false);
      return;
    }

    try {
      const answer = await askClaude(question, top, payMatches);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: answer, sources: top, payMatches },
      ]);
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: "Something went wrong reaching the model. Please try again.",
          sources: top,
          payMatches,
          error: true,
        },
      ]);
    }
    setLoading(false);
  }

  function toggleSection(id) {
    setExpandedSections((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <div
      style={{
        fontFamily: "'IBM Plex Sans', -apple-system, sans-serif",
        background: "#F7F5F0",
        minHeight: "100vh",
        color: "#1C2B33",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Serif:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-thumb { background: #C8C0AF; border-radius: 4px; }
        .section-chip {
          transition: all 0.15s ease;
        }
        .section-chip:hover {
          background: #1C2B33 !important;
          color: #F7F5F0 !important;
        }
        .ask-btn:hover:not(:disabled) {
          background: #0F3B57 !important;
        }
        .suggested-btn:hover {
          border-color: #16506E !important;
          color: #16506E !important;
        }
        textarea:focus, input:focus { outline: 2px solid #16506E; outline-offset: 1px; }
        @keyframes pulse {
          0%, 100% { opacity: 0.35; }
          50% { opacity: 1; }
        }
        .dot { animation: pulse 1.2s infinite ease-in-out; }
        .dot:nth-child(2) { animation-delay: 0.15s; }
        .dot:nth-child(3) { animation-delay: 0.3s; }
      `}</style>

      {/* Header */}
      <header
        style={{
          borderBottom: "3px solid #16506E",
          background: "#1C2B33",
          color: "#F7F5F0",
          padding: "20px 24px",
        }}
      >
        <div style={{ maxWidth: 880, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <span
              style={{
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: 11,
                letterSpacing: "0.12em",
                background: "#16506E",
                padding: "3px 8px",
                borderRadius: 3,
                color: "#F7F5F0",
              }}
            >
              BU 6 &middot; PROTOTYPE
            </span>
            <h1
              style={{
                fontFamily: "'IBM Plex Serif', serif",
                fontSize: 22,
                fontWeight: 600,
                margin: 0,
              }}
            >
              {MOU_META.title}
            </h1>
          </div>
          <p style={{ margin: "6px 0 0", fontSize: 13.5, color: "#B9C4CB" }}>
            {MOU_META.subtitle} &nbsp;&middot;&nbsp; Term: {MOU_META.term}
          </p>
        </div>
      </header>

      {/* Coverage notice */}
      <div
        style={{
          background: "#EFE6D0",
          borderBottom: "1px solid #D9CBA3",
          padding: "10px 24px",
          fontSize: 13,
        }}
      >
        <div style={{ maxWidth: 880, margin: "0 auto", color: "#5C4A1E" }}>
          <strong>Full document loaded:</strong> All 245 sections — Preamble through Article XXVII, all 19 sideletters, and all 12 appendix items.
        </div>
      </div>

      {/* Tab switcher */}
      <div style={{ background: "#FFFFFF", borderBottom: "1px solid #E3DCC9" }}>
        <div style={{ maxWidth: 880, margin: "0 auto", display: "flex", gap: 4, padding: "0 24px" }}>
          {[
            { id: "ask", label: "Ask the MOU" },
            { id: "deadlines", label: "Grievance Deadlines" },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              style={{
                background: "none",
                border: "none",
                borderBottom: activeTab === t.id ? "2.5px solid #16506E" : "2.5px solid transparent",
                color: activeTab === t.id ? "#16506E" : "#8A8477",
                fontWeight: activeTab === t.id ? 600 : 500,
                fontSize: 13.5,
                padding: "12px 4px",
                marginRight: 20,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === "deadlines" && (
        <main style={{ flex: 1, overflowY: "auto" }}>
          <DeadlineCalculator />
        </main>
      )}

      {activeTab === "ask" && (
      <>
      {/* Chat area */}
      <main
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "24px",
        }}
      >
        <div style={{ maxWidth: 880, margin: "0 auto" }}>
          {messages.length === 0 && (
            <div style={{ marginTop: 24 }}>
              <p style={{ fontSize: 15, color: "#495A63", marginBottom: 14 }}>
                Ask a question in plain language. The tool searches the loaded MOU text, then asks
                Claude to answer using only what it finds, with section citations.
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {SUGGESTED_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    className="suggested-btn"
                    onClick={() => handleAsk(q)}
                    style={{
                      textAlign: "left",
                      background: "#FFFFFF",
                      border: "1px solid #D9D2C0",
                      borderRadius: 8,
                      padding: "9px 12px",
                      fontSize: 13,
                      color: "#3A4750",
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} style={{ marginBottom: 20 }}>
              {m.role === "user" ? (
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <div
                    style={{
                      background: "#16506E",
                      color: "#fff",
                      borderRadius: "12px 12px 2px 12px",
                      padding: "10px 14px",
                      maxWidth: "80%",
                      fontSize: 14.5,
                      lineHeight: 1.5,
                    }}
                  >
                    {m.text}
                  </div>
                </div>
              ) : (
                <div>
                  <div
                    style={{
                      background: "#FFFFFF",
                      border: "1px solid #E3DCC9",
                      borderRadius: "2px 12px 12px 12px",
                      padding: "14px 16px",
                      fontSize: 14.5,
                      lineHeight: 1.6,
                      color: m.error ? "#8A3B2E" : "#1C2B33",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {m.text}
                  </div>
                  {m.sources && m.sources.length > 0 && (
                    <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {m.sources.map((s) => (
                        <button
                          key={s.id}
                          className="section-chip"
                          onClick={() => toggleSection(i + "-" + s.id)}
                          style={{
                            fontFamily: "'IBM Plex Mono', monospace",
                            fontSize: 11.5,
                            background: "#EFEAE0",
                            border: "1px solid #D9D2C0",
                            borderRadius: 6,
                            padding: "4px 9px",
                            cursor: "pointer",
                            color: "#3A4750",
                          }}
                        >
                          § {s.id} {expandedSections[i + "-" + s.id] ? "▾" : "▸"}
                        </button>
                      ))}
                    </div>
                  )}
                  {m.sources &&
                    m.sources.map(
                      (s) =>
                        expandedSections[i + "-" + s.id] && (
                          <div
                            key={s.id + "-panel"}
                            style={{
                              marginTop: 8,
                              background: "#FBFAF6",
                              border: "1px solid #E3DCC9",
                              borderLeft: "3px solid #16506E",
                              borderRadius: 6,
                              padding: "10px 14px",
                              fontSize: 13,
                              lineHeight: 1.55,
                              color: "#3A4750",
                            }}
                          >
                            <div
                              style={{
                                fontFamily: "'IBM Plex Serif', serif",
                                fontWeight: 600,
                                fontSize: 13.5,
                                marginBottom: 4,
                                color: "#1C2B33",
                              }}
                            >
                              {s.article} &mdash; {s.id} {s.title}
                            </div>
                            <div style={{ whiteSpace: "pre-wrap" }}>{s.text}</div>
                          </div>
                        )
                    )}
                  {m.payMatches && m.payMatches.length > 0 && (
                    <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                      {m.payMatches.map((p, pi) => (
                        <div
                          key={"pay-" + pi}
                          style={{
                            background: "#F0F4F0",
                            border: "1px solid #C9D6C9",
                            borderLeft: "3px solid #4A7A5A",
                            borderRadius: 6,
                            padding: "10px 14px",
                            fontSize: 12.5,
                            lineHeight: 1.5,
                            color: "#2E4A38",
                          }}
                        >
                          <div
                            style={{
                              fontFamily: "'IBM Plex Mono', monospace",
                              fontSize: 10.5,
                              letterSpacing: "0.06em",
                              color: "#4A7A5A",
                              marginBottom: 4,
                            }}
                          >
                            PAY SCALE REFERENCE &middot; NOT FROM THE MOU
                          </div>
                          <div style={{ fontWeight: 600, fontSize: 13.5, color: "#1C2B33", marginBottom: 2 }}>
                            {p.title}
                          </div>
                          <div style={{ marginBottom: 4 }}>{p.range}</div>
                          <div style={{ color: "#5C6E62", marginBottom: 4 }}>{p.note}</div>
                          <div style={{ fontSize: 11.5, color: "#5C6E62" }}>
                            Source: {p.source} &middot; {p.as_of}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          {loading && (
            <div
              style={{
                display: "inline-flex",
                gap: 5,
                background: "#FFFFFF",
                border: "1px solid #E3DCC9",
                borderRadius: "2px 12px 12px 12px",
                padding: "12px 16px",
              }}
            >
              <span className="dot" style={{ width: 6, height: 6, borderRadius: "50%", background: "#16506E" }} />
              <span className="dot" style={{ width: 6, height: 6, borderRadius: "50%", background: "#16506E" }} />
              <span className="dot" style={{ width: 6, height: 6, borderRadius: "50%", background: "#16506E" }} />
            </div>
          )}
        </div>
      </main>

      {/* Input */}
      <div style={{ borderTop: "1px solid #D9D2C0", background: "#F7F5F0", padding: "16px 24px" }}>
        <div style={{ maxWidth: 880, margin: "0 auto", display: "flex", gap: 8 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAsk()}
            placeholder="Ask about the MOU…"
            style={{
              flex: 1,
              padding: "12px 14px",
              borderRadius: 8,
              border: "1px solid #C8C0AF",
              fontSize: 14.5,
              fontFamily: "inherit",
              background: "#fff",
            }}
          />
          <button
            className="ask-btn"
            onClick={() => handleAsk()}
            disabled={loading || !query.trim()}
            style={{
              background: "#16506E",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              padding: "0 20px",
              fontSize: 14.5,
              fontWeight: 600,
              cursor: loading ? "default" : "pointer",
              opacity: loading || !query.trim() ? 0.6 : 1,
              fontFamily: "inherit",
            }}
          >
            Ask
          </button>
        </div>
      </div>
      </>
      )}
    </div>
  );
}
