// One public guide for the dashboard and the agent, including phone chats.
// Choosing a flow is education, never permission to enable an integration.
export const GET_STARTED_FLOWS = [
  {
    id: "chat", title: "Meet your agent", time: "2 minutes",
    description: "Connect a model and get one useful answer. Your agent keeps working between conversations when you enable background features.",
    steps: ["Connect your own model in Settings and save your dashboard login.", "Tell the agent what you want help with and how you prefer to work.", "Ask for one small result, then check the answer and model status."],
    link: "/setup", linkLabel: "Connect a model",
    prompt: "Help me get started with OpenAGI through chat. Ask what I want help with, one question at a time. Check which model and tools are actually available, explain any missing setup, then help me get one small useful result. Do not enable integrations or take external actions just to demonstrate them."
  },
  {
    id: "memory", title: "Teach it how you work", time: "3 minutes",
    description: "Preferences and corrections can carry across chats. Review what it remembers; useful routines can become skills you choose to adopt.",
    steps: ["Choose one non-sensitive preference you want remembered.", "Ask the agent to remember it, then ask it to recall it in another chat.", "Try correcting it and review the Memory and Skills tabs. Learning needs useful input and time; suggestions are not guaranteed."],
    link: "/?tab=memory", linkLabel: "Review memory",
    prompt: "Walk me through OpenAGI memory and learning, one step at a time. Ask me for one non-sensitive preference before storing anything. Help me verify recall and try a correction. Explain how observed routines become suggested skills and where I review them; do not invent memories or promise a learning timeline."
  },
  {
    id: "agents", title: "Monitor your coding agents", time: "5 minutes",
    description: "See what needs your attention across coding sessions. Start by observing; approved replies and managed runs are separate choices.",
    steps: ["Open Coding Agents to configure a supported CLI and select existing Git projects.", "Use Fleet to inspect recent sessions in observe mode. Available sources depend on the host and installed apps.", "Review a real session and its evidence. A reported status is not proof that code passed tests, merged, or shipped."],
    link: "/?tab=coding-agents", linkLabel: "Set up Coding Agents",
    prompt: "Help me monitor coding agents with OpenAGI. First ask which coding app and computer I use. Explain Coding Agents versus Fleet, check available read-only status, and walk me through setup in observe mode. Do not start a run, send a nudge, or switch to automatic mode without my separate request."
  },
  {
    id: "screen", title: "See your screen and take action", time: "5 minutes",
    description: "Screen observation gives context on macOS. Computer Use adds approved interaction on a selected, ready computer. Each is optional.",
    steps: ["On the Mac app, choose Capture from the menu bar to opt into observation and grant Screen Recording yourself.", "Review Computer History. Captured text is history; it does not prove live screen access or input readiness.", "For Computer Use, check the selected node and its permissions, then request a harmless read-only screen summary. Approve the session explicitly before interaction."],
    link: "/?tab=computer-use", linkLabel: "Check Computer Use",
    prompt: "Teach me screen observation and Computer Use in OpenAGI, one step at a time. First ask my operating system and whether I want observation or interactive control. Explain what is captured and sent to my model. Check readiness without starting a control session. Help me set up the supported path; ask before inspecting my screen or requesting a session, and never bypass operating-system permissions."
  },
  {
    id: "devices", title: "Connect your phone or another node", time: "5 minutes",
    description: "Keep a main agent on an always-on computer and reach it from your own devices. Pair each device with a scoped credential.",
    steps: ["Choose the main computer and a private network or authenticated HTTPS address the other device can reach.", "For iPhone or Android, install a build of the companion app and run openagi pair-phone on the main. App source is included; a public store download is not promised.", "For another computer, use openagi pair with the main address. Check Nodes for a fresh heartbeat and the capabilities that device actually offers. Glasses use Connect glasses."],
    link: "/?tab=nodes", linkLabel: "Review connected nodes",
    prompt: "Help me connect a device to OpenAGI. Ask whether it is an iPhone, Android phone, another computer, or Even G2, and where my main agent runs. Walk me through the matching pairing flow and verify reachability and a fresh heartbeat. Never ask me to paste tokens or pairing codes into chat. Explain that an online node only supports its advertised capabilities."
  },
  {
    id: "build", title: "Build your own agent or device", time: "Explore",
    description: "Inspect the runtime, add skills or MCP tools, and run it on Linux, a Raspberry Pi, or your own hardware. Bring your own model and accounts.",
    steps: ["Read the source and license: PolyForm Noncommercial 1.0.0 permits noncommercial use; it is not an OSI open-source license.", "Start with one skill or MCP connection before changing the runtime. Connect only tools and data you intend to share with your model.", "Run a separate node on supported hardware and test one advertised capability. Device integrations need their own compatible software and permissions."],
    link: "https://github.com/Spshulem/openAGI", linkLabel: "Explore the source",
    prompt: "Help me build on OpenAGI. Ask what I want to make and which hardware I have. Explain skills, MCP tools, and nodes, then suggest the smallest working example. Explain the current PolyForm Noncommercial license accurately; do not describe it as OSI open source or promise support for an untested device."
  }
];

export const GET_STARTED_GUIDANCE = `
When the user asks to get started, learn OpenAGI, or follow a guided setup:
- Start with their goal and operating system. Ask one question at a time, explain why the next step helps, and use one small verifiable result per step.
- Use available read-only tools to check current configuration. Say when you cannot check it. A configured key, discovered CLI, historical screenshot, or online node does not prove a working model, authenticated agent, live computer control, or completed work.
- Keep credentials in Settings or the local CLI, never in chat. Model requests can send selected context to the configured provider; local storage does not mean all inference stays on-device.
- Explain and guide first. Onboarding is not blanket authorization to capture screens, start computer control, connect accounts, send messages, run coding agents, or enable background automation. Retain the normal approval gates.
- Offer to verify the user's result, help recover a failed step, or skip it. Do not claim a step completed from a link click or elapsed time. The dashboard's Get started checklist is self-reported learning progress, not a capability check.
- Be concrete about the distinction: the persistent runtime can combine scheduled work, memory and corrections, optional observation, reviewed skills, and multiple scoped nodes. Benefits depend on the inputs, permissions, and models the user enables. Do not promise autonomous improvement or guaranteed results.
Setup paths:
${GET_STARTED_FLOWS.map(flow => `${flow.title}: ${flow.steps.join(" ")} Open ${flow.link}.`).join("\n")}
`;
