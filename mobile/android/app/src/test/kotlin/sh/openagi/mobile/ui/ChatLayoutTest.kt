package sh.openagi.mobile.ui

import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Test

// The chat's readable column: a phone keeps a slim gutter; a wide window
// (an unfolded Fold, a tablet) centres the messages at CHAT_MAX_WIDTH.
class ChatLayoutTest {
    @Test
    fun aPhoneKeepsTheMinimumGutter() {
        assertEquals(16.dp, chatGutter(412.dp))
    }

    @Test
    fun aWideWindowCentresTheColumn() {
        assertEquals(140.dp, chatGutter(1000.dp))
    }

    @Test
    fun justPastTheMaxWidthNeverDropsBelowTheMinimum() {
        assertEquals(16.dp, chatGutter(740.dp))
    }
}
