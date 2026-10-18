package sh.openagi.mobile.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Whether the chat follows the newest line is decided by the person's own
// drags and flings only, never by the list merely having more below it.
class ChatScrollTest {
    @Test
    fun movingBackTowardOlderMessagesScrollsAway() {
        assertTrue(ChatScroll.scrolledAwayAfterUserScroll(wasAway = false, deltaY = 40f, canScrollForward = true))
    }

    @Test
    fun reachingTheEndResumesFollowing() {
        assertFalse(ChatScroll.scrolledAwayAfterUserScroll(wasAway = true, deltaY = -40f, canScrollForward = false))
    }

    @Test
    fun movingTowardTheEndWithoutReachingItStaysAway() {
        assertTrue(ChatScroll.scrolledAwayAfterUserScroll(wasAway = true, deltaY = -40f, canScrollForward = true))
    }

    @Test
    fun aForwardDragWhileFollowingKeepsFollowing() {
        // A reply growing under the finger leaves more below; that is not
        // the person scrolling away.
        assertFalse(ChatScroll.scrolledAwayAfterUserScroll(wasAway = false, deltaY = -40f, canScrollForward = true))
    }

    @Test
    fun aDragOnAListThatCannotScrollNeverScrollsAway() {
        assertFalse(ChatScroll.scrolledAwayAfterUserScroll(wasAway = false, deltaY = 0f, canScrollForward = false))
    }
}
