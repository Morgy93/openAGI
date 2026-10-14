package sh.openagi.mobile.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.openagi.mobile.protocol.FleetDecision
import sh.openagi.mobile.protocol.FleetOpenChat
import sh.openagi.mobile.protocol.FleetQuestion
import sh.openagi.mobile.protocol.FleetThread
import sh.openagi.mobile.protocol.FleetWatch
import java.time.Instant

class WatchFormatTest {
    private val now = Instant.parse("2026-10-12T22:00:00Z")

    private fun minutesAgo(minutes: Long): Instant = now.minusSeconds(minutes * 60)

    private fun watched(key: String, group: String?, sinceMinutes: Long?, activityMinutes: Long? = null, waitingOn: String? = null) =
        FleetThread(
            key = key,
            state = "running",
            lastActivityAt = activityMinutes?.let(::minutesAgo),
            watch = group?.let { FleetWatch(group = it, since = sinceMinutes?.let(::minutesAgo), waitingOn = waitingOn) },
        )

    @Test
    fun groupsFollowTheWatchOrderWithOutOfScopeLast() {
        val groups = WatchFormat.groups(
            listOf(
                watched("q", "quiet", 5),
                watched("out", null, null),
                watched("b", "blocked", 5),
                watched("w", "waiting", 5),
                watched("y", "you", 5),
                watched("p", "push", 5),
                watched("k", "working", 5),
            ),
        )
        assertEquals(listOf("you", "working", "waiting", "push", "blocked", "quiet", "excluded"), groups.map { it.key })
        assertEquals(
            listOf("Waiting on you", "Working", "Waiting on CI or BuildBot3", "Needs a push", "Blocked by infra", "Quiet", "Out of scope"),
            groups.map { it.label },
        )
    }

    @Test
    fun onlyQuietAndOutOfScopeStartFolded() {
        val groups = WatchFormat.groups(listOf(watched("q", "quiet", 5), watched("out", null, null), watched("y", "you", 5)))
        assertEquals(mapOf("you" to false, "quiet" to true, "excluded" to true), groups.associate { it.key to it.collapsedByDefault })
    }

    @Test
    fun anUnknownGroupComesAfterTheKnownOnes() {
        val groups = WatchFormat.groups(listOf(watched("n", "new-kind", 5), watched("y", "you", 5)))
        assertEquals(listOf("you", "new-kind"), groups.map { it.key })
        assertEquals("New kind", groups.last().label)
    }

    @Test
    fun longestWaitFirstInsideAGroup() {
        val group = WatchFormat.groups(
            listOf(
                watched("recent", "waiting", 3),
                watched("undated", "waiting", null, activityMinutes = 1),
                watched("oldest", "waiting", 90),
                watched("middle", "waiting", 23),
            ),
        ).single()
        assertEquals(listOf("oldest", "middle", "recent", "undated"), group.threads.map { it.key })
    }

    @Test
    fun quietSortsByNewestActivity() {
        val group = WatchFormat.groups(
            listOf(
                watched("old-activity", "quiet", 500, activityMinutes = 300),
                watched("never", "quiet", 1),
                watched("new-activity", "quiet", 900, activityMinutes = 2),
            ),
        ).single()
        assertEquals(listOf("new-activity", "old-activity", "never"), group.threads.map { it.key })
    }

    @Test
    fun withoutWatchOnAnyRowItGroupsByStateAsBefore() {
        val threads = listOf(
            FleetThread(key = "done", state = "done", lastActivityAt = minutesAgo(5)),
            FleetThread(key = "run-old", state = "running", lastActivityAt = minutesAgo(30)),
            FleetThread(key = "needs", state = "needs-human"),
            FleetThread(key = "run-new", state = "running", lastActivityAt = minutesAgo(2)),
            FleetThread(key = "blank"),
        )
        assertFalse(WatchFormat.byWatch(threads))
        val groups = WatchFormat.groups(threads)
        assertEquals(listOf("needs-human", "running", "done", "unknown"), groups.map { it.key })
        assertEquals(listOf("Needs you", "Running", "Done", "Unknown"), groups.map { it.label })
        assertEquals(listOf("run-new", "run-old"), groups[1].threads.map { it.key })
        assertTrue(groups[2].collapsedByDefault)
    }

    @Test
    fun durationMatchesTheWebPage() {
        assertEquals("0s", WatchFormat.duration(-5))
        assertEquals("45s", WatchFormat.duration(45))
        assertEquals("1m", WatchFormat.duration(60))
        assertEquals("2m", WatchFormat.duration(90))
        assertEquals("23m", WatchFormat.duration(23 * 60))
        assertEquals("59m", WatchFormat.duration(59 * 60))
        assertEquals("1h", WatchFormat.duration(60 * 60))
        assertEquals("2h", WatchFormat.duration(90 * 60))
        assertEquals("47h", WatchFormat.duration(47 * 3600))
        assertEquals("2d", WatchFormat.duration(48 * 3600))
        assertEquals("3d", WatchFormat.duration(80 * 3600))
    }

    @Test
    fun aWaitingRowSaysWhatItWaitsOn() {
        val watch = FleetWatch(group = "waiting", since = minutesAgo(23), waitingOn = "BuildBot3 full run")
        assertEquals("on BuildBot3 full run for 23m", WatchFormat.watchLine(watch, now))
    }

    @Test
    fun otherRowsSayOnlyHowLong() {
        // "your answer" is what a you row waits on; the group already says so.
        val watch = FleetWatch(group = "you", since = minutesAgo(12), waitingOn = "your answer")
        assertEquals("for 12m", WatchFormat.watchLine(watch, now))
        assertEquals("for 1h", WatchFormat.watchLine(FleetWatch(group = "working", since = minutesAgo(60)), now))
    }

    @Test
    fun aWatchWithoutASinceHasNoDuration() {
        assertEquals("on CI", WatchFormat.watchLine(FleetWatch(group = "waiting", waitingOn = "CI"), now))
        assertNull(WatchFormat.watchLine(FleetWatch(group = "push"), now))
        assertNull(WatchFormat.watchLine(null, now))
    }

    @Test
    fun detailLinesForTheTurnTheWaitAndTheAgent() {
        val watch = FleetWatch(group = "push", since = minutesAgo(40), waitSince = minutesAgo(15), runningSince = minutesAgo(7))
        assertEquals("for 7m", WatchFormat.turnRunning(watch, now))
        assertEquals("for 15m", WatchFormat.waiting(watch, now))
        // On a waiting row the wait is the row line already.
        assertNull(WatchFormat.waiting(watch.copy(group = "waiting"), now))
        assertNull(WatchFormat.turnRunning(watch.copy(runningSince = null), now))
        assertEquals("just now", WatchFormat.ago(now.minusSeconds(20), now))
        assertEquals("12m ago", WatchFormat.ago(minutesAgo(12), now))
    }

    @Test
    fun prShortRefKeepsRepoAndNumber() {
        assertEquals("openAGI#178", WatchFormat.prShortRef("Spshulem/openAGI#178"))
        assertEquals("draft-7", WatchFormat.prShortRef("draft-7"))
        assertNull(WatchFormat.prShortRef(null))
        assertNull(WatchFormat.prShortRef(" "))
    }

    // ─── Open chat, row actions, question cards ───────────────────────────

    private val conductorChat = FleetOpenChat(
        app = "conductor",
        url = "conductor://workspace?id=w1&session=s1",
        label = "remote-dev · Codex LB Transcript open (Conductor)",
    )

    @Test
    fun aMacLinkNoAppHereTakesReadsOnYourMac() {
        val link = WatchFormat.chatLink(conductorChat) { false }!!
        assertNull(link.url)
        assertTrue(link.onMac)
        assertEquals("remote-dev · Codex LB Transcript open (Conductor)", link.label)
        assertEquals("Conductor", link.app)
    }

    @Test
    fun aMacLinkAnAppHereTakesOpensHere() {
        val link = WatchFormat.chatLink(conductorChat) { true }!!
        assertEquals("conductor://workspace?id=w1&session=s1", link.url)
        assertFalse(link.onMac)
    }

    // An http(s) link points at the Mac's apps or its loopback: never opened
    // from the phone, even though a browser here would take it.
    @Test
    fun anHttpLinkIsTheMacsEvenWhenABrowserCouldOpenIt() {
        val link = WatchFormat.chatLink(FleetOpenChat(app = "claude", url = "http://127.0.0.1:43210/x", label = "s")) { true }!!
        assertNull(link.url)
        assertTrue(link.onMac)
    }

    @Test
    fun noLinkKeepsTheNoteAndIsNotOnMac() {
        val chat = FleetOpenChat(app = "claude", url = null, label = "amman · Docs (Claude Code)", note = "open it in its terminal")
        val link = WatchFormat.chatLink(chat) { true }!!
        assertNull(link.url)
        assertFalse(link.onMac)
        assertEquals("open it in its terminal", link.note)
        assertNull(WatchFormat.chatLink(null) { true })
        assertEquals("Codex", WatchFormat.chatLink(FleetOpenChat(app = "codex"), { false })!!.label)
    }

    @Test
    fun rowActionsFollowTheGroupAndTheMute() {
        val unplanned = watched("p", "push", 5)
        assertEquals(listOf(WatchFormat.RowAction.MUTE), WatchFormat.rowActions(unplanned, now))
        val push = unplanned.copy(decision = FleetDecision(action = "wait"), pushPreview = FleetDecision(action = "nudge", message = "Preview"))
        assertEquals(listOf(WatchFormat.RowAction.PUSH, WatchFormat.RowAction.MUTE), WatchFormat.rowActions(push, now))
        assertEquals(listOf(WatchFormat.RowAction.UNMUTE), WatchFormat.rowActions(push.copy(muted = now.plusSeconds(3600)), now))
        // A mute that ran out is no mute.
        assertEquals(listOf(WatchFormat.RowAction.PUSH, WatchFormat.RowAction.MUTE), WatchFormat.rowActions(push.copy(muted = now.minusSeconds(1)), now))
        assertTrue(WatchFormat.rowActions(watched("w", "working", 5), now).isEmpty())
    }

    @Test
    fun mutedLineSaysHowLongIsLeft() {
        assertEquals("Muted, 23h left", WatchFormat.mutedLine(now.plusSeconds(23 * 3600), now))
        assertNull(WatchFormat.mutedLine(now, now))
        assertNull(WatchFormat.mutedLine(null, now))
    }

    @Test
    fun askedLineNamesWhenAndWhichChat() {
        val q = FleetQuestion(id = "q", askedAt = minutesAgo(180), createdAt = minutesAgo(10), chatLabel = "remote-dev · Codex LB Transcript open (Conductor)")
        assertEquals("Asked 3h ago in remote-dev · Codex LB Transcript open (Conductor)", WatchFormat.askedLine(q, "remote-dev", now))
        // No chat label from the daemon: the row's name stands in.
        assertEquals("Asked 10m ago in docs", WatchFormat.askedLine(FleetQuestion(id = "q", createdAt = minutesAgo(10)), "docs", now))
        assertNull(WatchFormat.askedLine(FleetQuestion(id = "q"), null, now))
    }

    @Test
    fun questionsForFindsOwnAndGroupQuestions() {
        val own = FleetQuestion(id = "a", threadKey = "codex:1")
        val grouped = FleetQuestion(id = "b", threadKeys = listOf("codex:2", "codex:1"))
        val other = FleetQuestion(id = "c", threadKey = "codex:3")
        assertEquals(listOf("a", "b"), WatchFormat.questionsFor("codex:1", listOf(own, grouped, other)).map { it.id })
    }

    @Test
    fun waitsOnUsesTheWaitStartOnAWaitingRow() {
        val watch = FleetWatch(group = "waiting", since = minutesAgo(60), waitingOn = "BuildBot3 full run", waitSince = minutesAgo(23))
        assertEquals("BuildBot3 full run, for 23m", WatchFormat.waitsOn(watch, now))
        assertEquals("your answer, for 1h", WatchFormat.waitsOn(FleetWatch(group = "you", since = minutesAgo(60), waitingOn = "your answer"), now))
        assertNull(WatchFormat.waitsOn(FleetWatch(group = "working", since = minutesAgo(5)), now))
    }

    @Test
    fun pushNoteSaysWhyARefusalSentNothing() {
        assertEquals(SupervisorFormat.Note("Not sent: waits on your answer first: Which fix?", isAlert = true), WatchFormat.pushNote("blocked", "waits on your answer first: Which fix?"))
        assertEquals(SupervisorFormat.Note("Pushed. The agent has your nudge.", isAlert = false), WatchFormat.pushNote("sent", null))
        assertEquals(SupervisorFormat.Note("Push failed.", isAlert = true), WatchFormat.pushNote("failed", " "))
    }

    @Test
    fun nextStepNamesTheActionAndPlaybook() {
        assertEquals("Nudge (pr-ci-failing)", WatchFormat.nextStep("nudge", "pr-ci-failing"))
        assertEquals("Ask owner", WatchFormat.nextStep("ask-owner", null))
        assertNull(WatchFormat.nextStep("none", "x"))
        assertNull(WatchFormat.nextStep(null, null))
    }

    @Test
    fun openThreadIsNotAnAnswerAndMacNavigationIsAnInstruction() {
        assertEquals(listOf("Apply fix A"), WatchFormat.answerOptions(FleetQuestion(options = listOf("open thread", "dismiss", "Apply fix A"))))
        val link = WatchFormat.chatLink(conductorChat) { false }!!
        assertEquals("Open this chat on your Mac in Conductor.", WatchFormat.chatInstruction(link))
    }
}
