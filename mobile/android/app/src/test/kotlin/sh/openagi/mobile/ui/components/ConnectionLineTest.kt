package sh.openagi.mobile.ui.components

import org.junit.Assert.assertEquals
import org.junit.Test

class ConnectionLineTest {
    @Test
    fun theHostAndStatusComeApartForTheConnectionDialog() {
        val state = ConnectionState.Reconnecting("mac.tail1234.ts.net:43210")
        assertEquals("mac.tail1234.ts.net:43210", connectionHost(state))
        assertEquals("reconnecting", connectionCaption(state))
    }

    @Test
    fun everyStateUsesTheSharedCaption() {
        assertEquals("live", connectionCaption(ConnectionState.Live("h")))
        assertEquals("can't reach", connectionCaption(ConnectionState.Failed("h", null)))
    }
}
