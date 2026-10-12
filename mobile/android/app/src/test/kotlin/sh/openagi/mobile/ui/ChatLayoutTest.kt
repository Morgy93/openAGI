package sh.openagi.mobile.ui

import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Test

// The chat's readable column: a phone keeps a slim gutter; a wide window
// (an unfolded Fold, a tablet) centres the messages at CHAT_MAX_WIDTH.
class ChatLayoutTest {
    @Test
    fun theColumnIsSixHundredWide() {
        assertEquals(600.dp, CHAT_MAX_WIDTH)
    }

    @Test
    fun aPhoneKeepsTheMinimumGutter() {
        assertEquals(16.dp, chatGutter(412.dp))
    }

    @Test
    fun theUnfoldedFoldInnerScreenCentresTheColumn() {
        // About 750 to 830 wide in portrait.
        assertEquals(75.dp, chatGutter(750.dp))
        assertEquals(115.dp, chatGutter(830.dp))
    }

    @Test
    fun aWideWindowCentresTheColumn() {
        assertEquals(200.dp, chatGutter(1000.dp))
    }

    @Test
    fun justPastTheMaxWidthNeverDropsBelowTheMinimum() {
        assertEquals(16.dp, chatGutter(620.dp))
    }

    @Test
    fun theComposerSitsFourOutsideTheTextColumn() {
        assertEquals(12.dp, composerInset(chatGutter(412.dp)))
        assertEquals(71.dp, composerInset(chatGutter(750.dp)))
    }
}
