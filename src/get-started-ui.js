import { GET_STARTED_FLOWS } from "./get-started.js";

function gettingStartedProgress() {
  try {
    const saved = JSON.parse(localStorage.getItem("openagi.getStarted.v1") || "[]");
    return new Set(Array.isArray(saved) ? saved.filter(id => GET_STARTED_FLOWS.some(flow => flow.id === id)) : []);
  } catch { return new Set(); }
}

async function startGettingStartedChat(id) {
  const flow = GET_STARTED_FLOWS.find(item => item.id === id);
  if (!flow) return;
  Object.assign(state, {
    sessionId: null, messages: [], freshChatRequested: true, agentId: "main",
    channel: "local", from: "browser-" + Date.now(), activeRequestId: null,
    activeRequestStage: null, activeRequestError: null, activeRequestMissingSince: null,
    activeRequestText: "", activeRequestModel: ""
  });
  // Clear an old session/compose handoff before opening this new conversation.
  const url = new URL(window.location.href);
  for (const key of ["session", "request", "compose", "suggestion", "pending"]) url.searchParams.delete(key);
  url.searchParams.set("tab", "chat");
  history.replaceState(null, "", url.toString());
  await switchTab("chat");
  const input = document.getElementById("input");
  if (input) {
    input.value = flow.prompt;
    input.dispatchEvent(new Event("input"));
    input.focus();
  }
  // Draft only. The user reads/edits the request and chooses Send.
}

function renderGettingStarted() {
  const progress = gettingStartedProgress();
  main.innerHTML = "";
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  main.append(el("h2", "Make OpenAGI useful to you"));
  main.append(el("p", "Pick one thing you want help with. Connect your model, then let the agent walk you through it in chat. You can skip a flow and come back any time.", "muted"));
  main.append(el("p", progress.size + " of " + GET_STARTED_FLOWS.length + " flows tried in this browser. This is your checklist, not a connection or permission check.", "muted"));
  const grid = el("div");
  Object.assign(grid.style, { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))", gap: "16px" });
  for (const flow of GET_STARTED_FLOWS) {
    const card = el("section", "", "card");
    card.style.padding = "18px";
    card.append(el("h3", flow.title));
    card.append(el("p", flow.time, "muted"));
    card.append(el("p", flow.description));
    const steps = el("ol");
    for (const step of flow.steps) steps.append(el("li", step));
    card.append(steps);
    const chat = el("button", "Guide me in chat", "ui-btn ui-btn-primary");
    chat.type = "button";
    chat.onclick = () => startGettingStartedChat(flow.id);
    const link = el("a", flow.linkLabel, "ui-btn ui-btn-secondary");
    link.href = flow.link;
    if (flow.link.startsWith("https://")) { link.target = "_blank"; link.rel = "noopener noreferrer"; }
    const actions = el("div", "", "row");
    Object.assign(actions.style, { gap: "8px", flexWrap: "wrap", margin: "12px 0" });
    actions.append(chat, link);
    card.append(actions);
    const label = el("label");
    const check = el("input");
    check.type = "checkbox";
    check.checked = progress.has(flow.id);
    check.onchange = () => {
      if (check.checked) progress.add(flow.id); else progress.delete(flow.id);
      try { localStorage.setItem("openagi.getStarted.v1", JSON.stringify([...progress])); } catch { /* private browsing */ }
      renderGettingStarted();
    };
    label.append(check, el("span", " I tried this flow"));
    card.append(label);
    grid.append(card);
  }
  main.append(grid);
  const guide = el("a", "Installation, troubleshooting, and first-use guide");
  guide.href = "https://github.com/Spshulem/openAGI/blob/main/docs/GETTING_STARTED.md";
  guide.target = "_blank";
  guide.rel = "noopener noreferrer";
  main.append(el("p", "Your agent's state is stored on its host. Model providers and connected services may receive the context needed for your requests. Start with non-sensitive examples.", "muted"), guide);
}

export const getStartedUi = `const GET_STARTED_FLOWS = ${JSON.stringify(GET_STARTED_FLOWS)};\n`
  + [gettingStartedProgress, startGettingStartedChat, renderGettingStarted].map(fn => fn.toString()).join("\n");
