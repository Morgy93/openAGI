package sh.openagi.mobile.ui

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

    private val PR_REF = Regex("""^[\w.-]+/([\w.-]+)#(\d+)$""")
}
