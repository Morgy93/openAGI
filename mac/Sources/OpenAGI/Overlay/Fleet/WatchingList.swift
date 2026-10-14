import SwiftUI

/// "Watching": every coding thread the supervisor watches, grouped by what it
/// waits on, with how long. One line per thread, a few per group, so the
/// panel stays short; the rest are on the /fleet page. Tapping a row opens
/// it: the agent's last words, the PR, the wait, the supervisor's next step,
/// and the row's actions (Answer or Dismiss when it waits on the owner, Push
/// now or Mute when it needs a push, Open chat on every row).
///
/// Like SupervisorSection, nothing that changes this view's height is
/// private @State: the open groups, the opened row, its detail and its action
/// results live on FleetConsumer, and OverlayView watches them and `threads`
/// so the panel resizes.
///
/// The sections scroll inside `maxListHeight`, like the questions and
/// approvals above them: the panel is capped at the screen's height, so an
/// uncapped list would be cut off on a laptop with everything else showing.
/// "N more" stays outside the scroll area so it is always reachable.
struct WatchingList: View {
  @ObservedObject var fleet = FleetConsumer.shared
  @ObservedObject var app = AppState.shared
  /// Tests render a fixed layout instead of the consumer's threads.
  var layoutOverride: FleetWatching.Layout? = nil

  static let maxListHeight: CGFloat = 220
  /// With a row opened: room for its detail and buttons.
  static let expandedListHeight: CGFloat = 400

  private var offline: Bool { app.status == .down }

  var body: some View {
    let layout = layoutOverride ?? FleetWatching.layout(fleet.threads, openGroups: fleet.openWatchGroups)
    if !layout.sections.isEmpty {
      VStack(alignment: .leading, spacing: 5) {
        Text("Watching").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
        ScrollViewReader { proxy in
          ScrollView {
            // Durations tick with the clock; every closed row stays one line,
            // so the panel's height never changes when they do.
            TimelineView(.periodic(from: .now, by: 30)) { context in
              VStack(alignment: .leading, spacing: 5) {
                ForEach(layout.sections) { section in
                  sectionView(section, now: context.date)
                }
              }
              .frame(maxWidth: .infinity, alignment: .leading)
            }
          }
          .frame(maxHeight: fleet.expandedThread == nil ? Self.maxListHeight : Self.expandedListHeight)
          .onChange(of: fleet.expandedThread) { _, key in
            guard let key else { return }
            withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo(key, anchor: .top) }
          }
        }
        if layout.hidden > 0 {
          Button("\(layout.hidden) more") { openFleetPage() }
            .buttonStyle(.plain).font(.system(size: 10)).foregroundStyle(.blue)
            .help("Open the fleet page")
        }
      }
    }
  }

  @ViewBuilder private func sectionView(_ section: FleetWatching.Section, now: Date) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      header(section)
      ForEach(section.rows) { thread in
        VStack(alignment: .leading, spacing: 3) {
          row(thread, now: now)
          if fleet.expandedThread == thread.key { opened(thread) }
        }
        .id(thread.key)
      }
    }
  }

  @ViewBuilder private func header(_ section: FleetWatching.Section) -> some View {
    let collapsible = FleetWatching.collapsedByDefault.contains(section.group)
    let title = HStack(spacing: 4) {
      if collapsible {
        Image(systemName: section.collapsed ? "chevron.right" : "chevron.down")
          .font(.system(size: 8, weight: .semibold))
      }
      Text(section.label).font(.system(size: 10, weight: .semibold))
      Text("\(section.total)").font(.system(size: 10)).foregroundStyle(.tertiary)
    }
    .foregroundStyle(tone(section.group))
    if collapsible {
      Button { fleet.toggleWatchGroup(section.group) } label: { title.contentShape(Rectangle()) }
        .buttonStyle(.plain)
        .help(section.collapsed ? "Show these threads" : "Hide these threads")
    } else {
      title
    }
  }

  private func row(_ thread: FleetThread, now: Date) -> some View {
    let wait = thread.watch.flatMap { FleetWatching.rowText($0, now: now) }
    let label = thread.watch.flatMap { FleetWatching.shortRowText($0, now: now) }
    let open = fleet.expandedThread == thread.key
    let muted = thread.muted.flatMap(FleetWatching.parseDate).map { $0 > now } ?? false
    return HStack(spacing: 6) {
      Button { fleet.toggleThread(thread.key) } label: {
        HStack(spacing: 6) {
          Image(systemName: open ? "chevron.down" : "chevron.right")
            .font(.system(size: 7, weight: .semibold)).foregroundStyle(.tertiary)
          Text(thread.name)
            .font(.system(size: 11))
            .lineLimit(1)
            .truncationMode(.tail)
          if muted {
            Image(systemName: "bell.slash").font(.system(size: 9)).foregroundStyle(.tertiary)
          }
          Spacer(minLength: 4)
          if let pr = thread.prShortRef {
            Text(pr).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1).fixedSize()
          }
          if let label {
            Text(label).font(.system(size: 10)).foregroundStyle(.tertiary).lineLimit(1).fixedSize()
          }
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .help([thread.name, thread.openChat?.label, thread.prRef, wait, muted ? "muted" : nil].compactMap { $0 }.joined(separator: " · "))
      if let chat = thread.openChat, FleetChatOpener.buttonTitle(chat) != nil {
        Button { fleet.openChat(chat) } label: {
          Image(systemName: "arrow.up.forward.app").font(.system(size: 10))
        }
        .buttonStyle(.plain).foregroundStyle(.secondary)
        .help("\(FleetChatOpener.buttonTitle(chat) ?? "Open chat"): \(chat.label)")
      }
    }
    .padding(.leading, 6)
    // Clear of the overlay scroller, which otherwise covers the durations.
    .padding(.trailing, 14)
    .contextMenu {
      if let chat = thread.openChat, let title = FleetChatOpener.buttonTitle(chat) {
        Button(title) { fleet.openChat(chat) }
      }
      if let url = thread.prLink {
        Button("Open pull request") { NSWorkspace.shared.open(url) }
      }
      if muted {
        Button("Unmute") { Task { await fleet.unmute(thread.key) } }
      } else {
        Button("Mute for 24 hours") { Task { await fleet.mute(thread.key) } }
      }
      Button("Open fleet page") { openFleetPage() }
    }
  }

  /// The opened row: where the chat is, what the agent last said, the PR,
  /// the wait and the next step, then the actions its group takes.
  private func opened(_ thread: FleetThread) -> some View {
    let detail = fleet.details[thread.key]
    let summary = FleetThreadSummary(thread: thread, detail: detail)
    let group = thread.watch?.group
    let asks = fleet.questions(about: thread.key)
    let busy = fleet.threadInFlight.contains(thread.key)
    return VStack(alignment: .leading, spacing: 5) {
      if let chat = thread.openChat ?? detail?.openChat {
        FleetOpenChatLine(chat: chat)
      }
      FleetThreadLines(summary: summary)
      if group == "you" {
        ForEach(asks) { question in
          FleetQuestionAnswer(question: question)
            .padding(6)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color.orange.opacity(0.08)))
        }
      }
      if group == "push", !summary.muted, let message = summary.pushMessage {
        Text("Push now sends:").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
        Text(message)
          .font(.system(size: 11))
          .lineLimit(8)
          .help(message)
          .padding(6)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.05)))
      }
      HStack(spacing: 8) {
        if group == "push", !summary.muted {
          Button("Push now") { Task { await fleet.pushNow(thread.key) } }
            .controlSize(.small).buttonStyle(.borderedProminent)
            .disabled(busy || offline)
            .help("Send the supervisor's planned nudge now, as your own message")
        }
        Button(summary.muted ? "Unmute" : "Mute 24h") {
          Task { summary.muted ? await fleet.unmute(thread.key) : await fleet.mute(thread.key) }
        }
        .buttonStyle(.borderless).font(.system(size: 10))
        .disabled(busy || offline)
        .help(summary.muted ? "Watch and nudge this thread again" : "No nudge or question about this thread for a day")
        Button("Fleet page") { openFleetPage() }
          .buttonStyle(.borderless).font(.system(size: 10))
        Spacer(minLength: 0)
        if busy || fleet.detailLoading.contains(thread.key) { ProgressView().controlSize(.small) }
      }
      if let note = fleet.threadNotes[thread.key] {
        FleetNoteRow(note: note) { fleet.clearThreadNote(thread.key) }
      }
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 6)
    .padding(.trailing, 8)
    .background(RoundedRectangle(cornerRadius: 6).fill(Color.accentColor.opacity(0.06)))
  }

  private func tone(_ group: String) -> Color {
    switch group {
    case "you": return .orange
    case "working", "waiting": return .green
    case "push", "blocked": return .yellow
    default: return .secondary
    }
  }

  private func openFleetPage() { AppState.shared.openDashboard(path: "/fleet") }
}
