const STORAGE_KEY = "outcurve-hook-tool-anthropic-key";
const MAX_TRANSCRIPT_CHARS = 10000;
const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const MODES = {
  "subject-lines": { promptFile: "prompts/subject-lines.txt", label: "Subject lines", form: "generate" },
  "ig-first-lines": { promptFile: "prompts/ig-first-lines.txt", label: "IG first-lines", form: "generate" },
  "post-intros":    { promptFile: "prompts/post-intros.txt",    label: "Post intros",    form: "generate" },
  "extract-hook":   { promptFile: "prompts/extract-hook.txt",   label: "Extract hook",   form: "extract" },
};

const state = {
  apiKey: null,
  icps: null,
  corpus: null,
  prompts: {},
  mode: "subject-lines",
  inFlight: false,
};

async function init() {
  await loadData();
  populatePersonaSelect();
  bindEvents();
  switchMode("subject-lines");

  state.apiKey = localStorage.getItem(STORAGE_KEY);
  if (!state.apiKey) showKeyModal();
}

async function loadData() {
  const promptEntries = Object.entries(MODES);
  const [icps, corpus, ...promptTexts] = await Promise.all([
    fetch("data/icps.json").then(r => r.json()),
    fetch("data/hooks-corpus.json").then(r => r.json()),
    ...promptEntries.map(([, m]) => fetch(m.promptFile).then(r => r.text())),
  ]);
  state.icps = icps;
  state.corpus = corpus;
  promptEntries.forEach(([key], i) => { state.prompts[key] = promptTexts[i]; });
}

function populatePersonaSelect() {
  const sel = document.getElementById("persona-select");
  sel.innerHTML = '<option value="">No specific persona</option>';
  state.icps.personas.forEach(p => {
    const opt = document.createElement("option");
    opt.value = String(p.id);
    opt.textContent = `${p.id}. ${p.shape}`;
    sel.appendChild(opt);
  });
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach(t => {
    t.addEventListener("click", () => switchMode(t.dataset.mode));
  });
  document.getElementById("generate-btn").addEventListener("click", handleGenerate);
  document.getElementById("extract-btn").addEventListener("click", handleExtract);
  document.getElementById("reset-key").addEventListener("click", resetKey);
  document.getElementById("key-save").addEventListener("click", saveKey);
  document.getElementById("key-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveKey();
  });
  document.getElementById("transcript").addEventListener("input", (e) => {
    document.getElementById("transcript-count").textContent = e.target.value.length;
  });
}

function switchMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".tab").forEach(t => {
    t.classList.toggle("active", t.dataset.mode === mode);
  });
  const isExtract = MODES[mode].form === "extract";
  document.querySelector('[data-form="generate"]').classList.toggle("hidden", isExtract);
  document.querySelector('[data-form="extract"]').classList.toggle("hidden", !isExtract);
  document.getElementById("output").textContent = "";
  document.getElementById("output-label").textContent = MODES[mode].label;
  setStatus("", "");
}

function buildPersonaBlock(personaId) {
  if (!personaId) {
    return "No specific persona selected. Write for a general health-conscious audience that responds to specificity, named evidence, and reframes of received wisdom.";
  }
  const p = state.icps.personas.find(x => x.id === Number(personaId));
  if (!p) return "Unknown persona.";
  return [
    `Persona: ${p.shape} — ${p.one_liner}`,
    `Verb: ${p.verb}`,
    `Demographics: ${p.demographics}`,
    `Currently uses: ${p.currently_uses}`,
    `Trigger moments: ${p.trigger_moments.join("; ")}`,
    `Direct competitors: ${p.direct_competitors}`,
    `Where Outcurve sits: ${p.where_outcurve_sits}`,
    `How they process communication: ${p.communication_style}`,
    `Scroll context: ${p.scroll_context}`,
    `Best creative grammar: ${p.best_creative_grammar}`,
    `Lead features by format: demo-led — ${p.lead_features_by_format.demo_led}; story-led — ${p.lead_features_by_format.story_led}; problem-led — ${p.lead_features_by_format.problem_led}; persona-led — ${p.lead_features_by_format.persona_led}`,
    `Relevant features: ${p.relevant_features}`,
  ].join("\n");
}

function buildHooksBlock(personaId, n = 12) {
  const personaShape = personaId ? state.icps.personas.find(x => x.id === Number(personaId))?.shape : null;
  const all = state.corpus.hooks.slice();
  const matching = personaShape ? all.filter(h => h.persona_match === personaShape) : [];
  const others = personaShape ? all.filter(h => h.persona_match !== personaShape) : all;
  shuffle(matching); shuffle(others);
  const targetMatching = Math.min(matching.length, Math.ceil(n * 0.55));
  const sample = [...matching.slice(0, targetMatching), ...others.slice(0, n - targetMatching)];
  return sample.map((h, i) => {
    const tags = [h.shape, h.persona_match ? `persona: ${h.persona_match}` : null].filter(Boolean).join(", ");
    return `Example ${i + 1} [${tags}]:\n"${h.hook}"\nNote: ${h.notes}`;
  }).join("\n\n");
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function fillTemplate(tpl, vars) {
  return Object.entries(vars).reduce((acc, [k, v]) => acc.split(`{{${k}}}`).join(v), tpl);
}

async function handleGenerate() {
  if (!state.apiKey) { showKeyModal(); return; }
  if (state.inFlight) return;

  const topic = document.getElementById("topic").value.trim();
  if (!topic) { setStatus("Add a topic / angle.", "warn"); return; }

  const personaId = document.getElementById("persona-select").value;
  const formatVal = document.getElementById("format-select").value;
  const tone      = document.getElementById("tone").value.trim() || "no specific tone modifier";
  const count     = String(document.getElementById("count").value || 10);

  const personaBlock = buildPersonaBlock(personaId);
  const hooksBlock   = buildHooksBlock(personaId, 12);
  const formatHint   = formatVal === "any"
    ? "No fixed creative format — pick the strongest fit per output, varying across the set."
    : `Lean into the ${formatVal.replace("_", "-")} creative format.`;

  const tpl = state.prompts[state.mode];
  const [systemTplRaw, userTplRaw] = splitTemplate(tpl, "# User input");

  const systemText = fillTemplate(systemTplRaw, {
    PERSONA_BLOCK: personaBlock,
    FORMAT_HINT: formatHint,
    HOOKS_BLOCK: hooksBlock,
  });
  const userText = fillTemplate(userTplRaw, { TOPIC: topic, TONE: tone, COUNT: count });

  await runStream({ systemText, userText });
}

async function handleExtract() {
  if (!state.apiKey) { showKeyModal(); return; }
  if (state.inFlight) return;

  const transcript = document.getElementById("transcript").value.trim();
  if (!transcript) { setStatus("Paste a transcript first.", "warn"); return; }
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    setStatus(`Transcript too long (${transcript.length.toLocaleString()} chars, max ${MAX_TRANSCRIPT_CHARS.toLocaleString()}).`, "warn");
    return;
  }

  const personaList = state.icps.personas.map(p => `- ${p.shape}: ${p.one_liner}`).join("\n");
  const tpl = state.prompts["extract-hook"];
  const [systemTplRaw, userTplRaw] = splitTemplate(tpl, "# Transcript");

  const systemText = fillTemplate(systemTplRaw, { PERSONA_LIST: personaList });
  const userText = fillTemplate(userTplRaw, { TRANSCRIPT: transcript });

  await runStream({ systemText, userText });
}

function splitTemplate(tpl, marker) {
  const idx = tpl.indexOf(marker);
  if (idx === -1) return [tpl, ""];
  return [tpl.slice(0, idx).trim(), tpl.slice(idx)];
}

async function runStream({ systemText, userText }) {
  const out = document.getElementById("output");
  out.textContent = "";
  setStatus("Streaming…", "busy");
  state.inFlight = true;
  setButtonsDisabled(true);

  const model = document.getElementById("model-select").value;

  const body = {
    model,
    max_tokens: 2048,
    stream: true,
    system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userText }],
  };

  let usage = null;
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": state.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => "");
      let parsed = null;
      try { parsed = JSON.parse(errText); } catch {}
      const msg = parsed?.error?.message || errText || `HTTP ${res.status}`;
      throw new Error(msg);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          const ev = JSON.parse(payload);
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
            out.textContent += ev.delta.text;
          } else if (ev.type === "message_start" && ev.message?.usage) {
            usage = { ...ev.message.usage };
          } else if (ev.type === "message_delta" && ev.usage) {
            usage = { ...(usage || {}), ...ev.usage };
          }
        } catch {
          // ignore non-JSON SSE lines (e.g., ping comments)
        }
      }
    }

    if (usage) {
      const cached = usage.cache_read_input_tokens || 0;
      const written = usage.cache_creation_input_tokens || 0;
      const inTok = usage.input_tokens || 0;
      const outTok = usage.output_tokens || 0;
      setStatus(`Done · in ${inTok}+${written}w+${cached}r · out ${outTok}`, "ok");
    } else {
      setStatus("Done", "ok");
    }
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`, "err");
  } finally {
    state.inFlight = false;
    setButtonsDisabled(false);
  }
}

function setButtonsDisabled(disabled) {
  document.getElementById("generate-btn").disabled = disabled;
  document.getElementById("extract-btn").disabled = disabled;
}

function setStatus(msg, kind) {
  const s = document.getElementById("status");
  s.textContent = msg;
  s.className = `status ${kind || ""}`;
}

function showKeyModal() {
  const m = document.getElementById("key-modal");
  m.classList.remove("hidden");
  m.setAttribute("aria-hidden", "false");
  const input = document.getElementById("key-input");
  input.value = state.apiKey || "";
  setTimeout(() => input.focus(), 50);
}

function hideKeyModal() {
  const m = document.getElementById("key-modal");
  m.classList.add("hidden");
  m.setAttribute("aria-hidden", "true");
}

function saveKey() {
  const v = document.getElementById("key-input").value.trim();
  if (!v.startsWith("sk-")) {
    setStatus("That doesn't look like an Anthropic API key (expected sk-ant-...).", "warn");
    return;
  }
  state.apiKey = v;
  localStorage.setItem(STORAGE_KEY, v);
  hideKeyModal();
  setStatus("Key saved", "ok");
}

function resetKey() {
  localStorage.removeItem(STORAGE_KEY);
  state.apiKey = null;
  showKeyModal();
}

init().catch((err) => {
  console.error(err);
  setStatus(`Init failed: ${err.message}`, "err");
});
