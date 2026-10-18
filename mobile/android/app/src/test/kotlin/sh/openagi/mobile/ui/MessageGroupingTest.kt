package sh.openagi.mobile.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// DESIGN.md's Chat section: the owner's back-to-back bubbles tighten to 4; a
// change of speaker, or a reply right after a reply, opens to 12. No timestamp
// unless more than 15 minutes passed, and then it is a centred caption in
// muted between the two groups.
class MessageGroupingTest {
    @Test
    fun theFirstMessageInAConversationGetsNoTopSpacing() {
        assertEquals(0, MessageGrouping.spacingBeforeDp(null, null, currentIsUser = true, currentEpochSeconds = 1_000))
    }

    @Test
    fun ownerBubblesBackToBackTightenTo4Dp() {
        val spacing = MessageGrouping.spacingBeforeDp(
            previousIsUser = true,
            previousEpochSeconds = 1_000,
            currentIsUser = true,
            currentEpochSeconds = 1_010,
        )
        assertEquals(4, spacing)
    }

    @Test
    fun backToBackRepliesKeepAClearGap() {
        // Replies have no bubble, so two of them tightened together would
        // read as one long answer.
        val spacing = MessageGrouping.spacingBeforeDp(
            previousIsUser = false,
            previousEpochSeconds = 1_000,
            currentIsUser = false,
            currentEpochSeconds = 1_010,
        )
        assertEquals(12, spacing)
    }

    @Test
    fun aChangeOfSpeakerOpensTo12Dp() {
        val spacing = MessageGrouping.spacingBeforeDp(
            previousIsUser = true,
            previousEpochSeconds = 1_000,
            currentIsUser = false,
            currentEpochSeconds = 1_010,
        )
        assertEquals(12, spacing)
    }

    @Test
    fun noDividerBeforeFifteenMinutesHavePassed() {
        val fourteenMinutesLater = 1_000L + 14 * 60
        assertFalse(MessageGrouping.needsTimestampDivider(1_000, fourteenMinutesLater))
    }

    @Test
    fun aDividerAppearsOnceMoreThanFifteenMinutesHavePassed() {
        val sixteenMinutesLater = 1_000L + 16 * 60
        assertTrue(MessageGrouping.needsTimestampDivider(1_000, sixteenMinutesLater))
    }

    @Test
    fun aTimestampGapOpensToGroupSpacingEvenForTheSameSpeaker() {
        // A long pause from the same speaker still isn't a "tight" follow-up
        // — the divider already marks the break, so the message under it
        // opens at the wider spacing rather than tightening.
        val sixteenMinutesLater = 1_000L + 16 * 60
        val spacing = MessageGrouping.spacingBeforeDp(
            previousIsUser = true,
            previousEpochSeconds = 1_000,
            currentIsUser = true,
            currentEpochSeconds = sixteenMinutesLater,
        )
        assertEquals(12, spacing)
    }

    @Test
    fun aMissingPreviousTimestampNeverNeedsADivider() {
        assertFalse(MessageGrouping.needsTimestampDivider(null, 1_000))
    }
}
