package sh.openagi.mobile.ui

import sh.openagi.mobile.protocol.FleetOpenChat
import sh.openagi.mobile.protocol.FleetQuestion
import sh.openagi.mobile.protocol.FleetThread
import sh.openagi.mobile.protocol.FleetWatch
import java.time.Duration
import java.time.Instant

// The Supervisor tab's Watching list, kept pure so tests can pin it: which
// group each thread is in, the groups' order and names, the order inside a
// group, and the "on BuildBot3 full run for 23m" line. It follows the /fleet
// page's renderFleet and watchText (src/fleet/page.js) so the phone and the
// dashboard group and word a thread the same way.
object WatchFormat {
    const val EXCLUDED = "excluded"
    const val QUIET = "quiet"

    val WATCH_ORDER = listOf("you", "working", "waiting", "push", "blocked", QUIET)

    private val WATCH_LABEL = mapOf(
        "you" to "Waiting on you",
        "working" to "Working",
        "waiting" to "Waiting on CI or BuildBot3",
        "push" to "Needs a push",
        "blocked" to "Blocked by infra",
        QUIET to "Quiet",
    )

    // A daemon from before watch groups by state, in the page's order.
    val STATE_ORDER = listOf(
        "needs-human", "ready-needs-human", "stopped", "asked-in-scope", "pr-not-ready", "infra-blocked",
        "local-verify", "waiting-ci", "running", "idle-no-pr", "done", EXCLUDED,
    )

    // Folded until opened: nothing in them is waiting on anyone.
    private val COLLAPSED = setOf(QUIET, EXCLUDED, "done", "idle-no-pr")

    data class Group(
        val key: String,
        val label: String,
        val threads: List<FleetThread>,
        val collapsedByDefault: Boolean,
    )

    fun byWatch(threads: List<FleetThread>): Boolean = threads.any { it.watch != null }

    fun groupLabel(key: String, byWatch: Boolean): String =
        (if (byWatch) WATCH_LABEL[key] else null) ?: SupervisorFormat.stateLabel(key)

    // Watch groups in WATCH_ORDER, out of scope last, anything unknown after.
    // Without watch on any row, state groups as before. Inside a group the
    // longest wait comes first, except Quiet and out of scope, newest first.
    fun groups(threads: List<FleetThread>): List<Group> {
        val watching = byWatch(threads)
        val grouped = LinkedHashMap<String, MutableList<FleetThread>>()
        threads.forEach { thread ->
            val key = if (watching) {
                thread.watch?.group?.takeIf { it.isNotBlank() } ?: EXCLUDED
            } else {
                thread.state?.takeIf { it.isNotBlank() } ?: "unknown"
            }
            grouped.getOrPut(key) { mutableListOf() }.add(thread)
        }
        val known = if (watching) WATCH_ORDER + EXCLUDED else STATE_ORDER
        val order = known.filter { it in grouped } + grouped.keys.filter { it !in known }
        return order.map { key ->
            val list = grouped.getValue(key)
            val longestFirst = watching && key != QUIET && key != EXCLUDED
            Group(
                key = key,
                label = groupLabel(key, watching),
                threads = if (longestFirst) list.sortedWith(LONGEST_WAIT_FIRST) else list.sortedWith(NEWEST_FIRST),
                collapsedByDefault = key in COLLAPSED,
            )
        }
    }

    private val NEWEST_FIRST: Comparator<FleetThread> =
        compareByDescending<FleetThread> { it.lastActivityAt?.toEpochMilli() ?: Long.MIN_VALUE }
            .thenBy { SupervisorFormat.name(it).lowercase() }

    // Oldest since first; a row without one has nothing to rank by, so last.
    private val LONGEST_WAIT_FIRST: Comparator<FleetThread> =
        compareBy<FleetThread> { it.watch?.since?.toEpochMilli() ?: Long.MAX_VALUE }
            .then(NEWEST_FIRST)

    // "45s", "23m", "5h", "3d" — the page's secs(): rounded, hours under 48,
    // days after. A negative span (a clock ahead of the daemon) reads 0s.
    fun duration(seconds: Long): String {
        if (seconds < 60) return "${seconds.coerceAtLeast(0)}s"
        val minutes = Math.round(seconds / 60.0)
        if (minutes < 60) return "${minutes}m"
        val hours = Math.round(minutes / 60.0)
        if (hours < 48) return "${hours}h"
        return "${Math.round(hours / 24.0)}d"
    }

    fun duration(from: Instant, now: Instant): String = duration(Duration.between(from, now).seconds)

    // "on BuildBot3 full run for 23m" for a waiting row, "for 12m" for any
    // other; null when there is nothing to say.
    fun watchLine(watch: FleetWatch?, now: Instant): String? {
        watch ?: return null
        val on = watch.waitingOn?.takeIf { it.isNotBlank() && watch.group == "waiting" }?.let { "on $it" }
        val span = watch.since?.let { "for " + duration(it, now) }
        return listOfNotNull(on, span).joinToString(" ").ifBlank { null }
    }

    // "for 12m" when the agent's turn has a start, else null.
    fun turnRunning(watch: FleetWatch?, now: Instant): String? =
        watch?.runningSince?.let { "for " + duration(it, now) }

    // The wait outside the waiting group, where the row line already says it.
    fun waiting(watch: FleetWatch?, now: Instant): String? =
        watch?.takeIf { it.group != "waiting" }?.waitSince?.let { "for " + duration(it, now) }

    // "12m ago", "just now".
    fun ago(at: Instant, now: Instant): String {
        val seconds = Duration.between(at, now).seconds
        return if (seconds < 60) "just now" else duration(seconds) + " ago"
    }

    // "owner/openAGI#178" -> "openAGI#178", the page's shortRef; anything
    // else is shown as it came.
    fun prShortRef(ref: String?): String? {
        if (ref.isNullOrBlank()) return null
        return PR_REF.matchEntire(ref)?.let { it.groupValues[1] + "#" + it.groupValues[2] } ?: ref
    }

    // "you wrote 2h ago": the owner's own last message in the chat.
    fun ownerLine(at: Instant?, now: Instant): String? = at?.let { "You wrote " + ago(it, now) }

    // "your answer, for 3h" / "BuildBot3 full run, for 23m": what the row
    // waits on, from when; null when the daemon names nothing.
    fun waitsOn(watch: FleetWatch?, now: Instant): String? {
        val on = watch?.waitingOn?.takeIf { it.isNotBlank() } ?: return null
        val from = (if (watch.group == "waiting") watch.waitSince else null) ?: watch.since ?: watch.waitSince
        return on + (from?.let { ", for " + duration(it, now) } ?: "")
    }

    // "Muted, 23h left"; null once it has run out (the daemon drops it too).
    fun mutedLine(muted: Instant?, now: Instant): String? {
        muted ?: return null
        if (!muted.isAfter(now)) return null
        return "Muted, " + duration(Duration.between(now, muted).seconds) + " left"
    }

    // What the owner can do to a row besides answering its questions: Push
    // now and Mute on "Needs a push", Unmute on any muted row. A muted row
    // offers nothing else, since the daemon refuses to push it.
    enum class RowAction { PUSH, MUTE, UNMUTE }

    fun rowActions(thread: FleetThread, now: Instant): List<RowAction> = when {
        mutedLine(thread.muted, now) != null -> listOf(RowAction.UNMUTE)
        thread.watch?.group == "push" -> if (thread.pushPreview?.action == "nudge" && !thread.pushPreview.message.isNullOrBlank())
            listOf(RowAction.PUSH, RowAction.MUTE) else listOf(RowAction.MUTE)
        else -> emptyList()
    }

    // The open questions about one thread, its own or a group's.
    fun questionsFor(key: String, questions: List<FleetQuestion>): List<FleetQuestion> =
        questions.filter { it.id.isNotBlank() && (it.threadKey == key || it.threadKeys.orEmpty().contains(key)) }

    // "Asked 3h ago in remote-dev · Codex LB Transcript open (Conductor)":
    // when the agent asked, and in which chat, so two chats with one
    // workspace name are told apart.
    fun askedLine(question: FleetQuestion, fallbackChat: String?, now: Instant): String? {
        val at = (question.askedAt ?: question.createdAt)?.let { "Asked " + ago(it, now) }
        val chat = question.chatLabel?.takeIf { it.isNotBlank() } ?: fallbackChat?.takeIf { it.isNotBlank() }
        return when {
            at != null && chat != null -> "$at in $chat"
            at != null -> at
            chat != null -> "In $chat"
            else -> null
        }
    }

    fun appName(app: String?): String? = when (app) {
        "conductor" -> "Conductor"
        "codex" -> "Codex"
        "claude" -> "Claude Code"
        null, "" -> null
        else -> app.replaceFirstChar { it.uppercase() }
    }

    // Open chat as the phone can offer it. url: a link this phone opens
    // (only the Mac apps' own schemes, and only when an app here claims
    // them). onMac: the chat has a link, but only the Mac opens it; an
    // http(s) link is the Mac's too, since it points at the Mac's apps or
    // its loopback. Neither: no link opens the chat anywhere, and note
    // says where to find it.
    data class ChatLink(val label: String, val app: String?, val url: String?, val onMac: Boolean, val note: String?)

    fun chatLink(chat: FleetOpenChat?, canOpen: (String) -> Boolean): ChatLink? {
        chat ?: return null
        val app = appName(chat.app)
        val label = chat.label?.takeIf { it.isNotBlank() } ?: app ?: return null
        val url = chat.url?.trim()?.takeIf { it.isNotEmpty() }
        val here = url?.takeIf { APP_LINK.containsMatchIn(it) && canOpen(it) }
        return ChatLink(label, app, here, onMac = url != null && here == null, note = chat.note?.takeIf { it.isNotBlank() })
    }

    // Open thread is navigation, never an answer sent to the agent.
    fun chatInstruction(link: ChatLink): String = when {
        link.onMac -> "Open this chat on your Mac" + (link.app?.let { " in $it" } ?: "") + "."
        else -> link.note ?: ("On your Mac" + (link.app?.let { ", in $it" } ?: "") + ".")
    }

    fun answerOptions(question: FleetQuestion): List<String> =
        question.options.filter { it.isNotBlank() && it != "dismiss" && it != "open thread" }

    // What happened to a Push now. A refusal sends nothing, so nothing is
    // "saved" the way an answer is: it says why, in the daemon's words.
    fun pushNote(status: String?, detail: String?): SupervisorFormat.Note {
        val why = detail?.trim()?.takeIf { it.isNotEmpty() }
        return when (status) {
            "sent" -> SupervisorFormat.Note("Pushed. The agent has your nudge.", isAlert = false)
            "blocked" -> SupervisorFormat.Note("Not sent" + (why?.let { ": $it" } ?: "."), isAlert = true)
            "failed" -> SupervisorFormat.Note("Push failed" + (why?.let { ": $it" } ?: "."), isAlert = true)
            else -> SupervisorFormat.Note("Pushed.", isAlert = false)
        }
    }

    // The supervisor's next step in words: "Nudge (pr-ci-failing), not
    // before 3:40 PM" without the clock, which the screen formats.
    fun nextStep(action: String?, playbook: String?): String? {
        val what = action?.takeIf { it.isNotBlank() && it != "none" } ?: return null
        val named = what.replace('-', ' ').replaceFirstChar { it.uppercase() }
        return named + (playbook?.takeIf { it.isNotBlank() }?.let { " ($it)" } ?: "")
    }

    private val APP_LINK = Regex("""^(conductor|codex)://""", RegexOption.IGNORE_CASE)

    private val PR_REF = Regex("""^[\w.-]+/([\w.-]+)#(\d+)$""")
}
