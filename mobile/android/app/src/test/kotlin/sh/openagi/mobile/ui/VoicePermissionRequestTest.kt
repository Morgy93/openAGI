package sh.openagi.mobile.ui

import androidx.lifecycle.Lifecycle
import org.junit.Assert.*
import org.junit.Test

class VoicePermissionRequestTest {
    @Test fun firstHandsFreeGrantWaitsForResumeAndStartsOnce() {
        val request = VoicePermissionRequest()
        request.handsFree()
        // The permission dialog pauses voice, then delivers its result before resume.
        assertFalse(request.lifecycle(Lifecycle.Event.ON_PAUSE))
        request.result(true)
        assertTrue(request.lifecycle(Lifecycle.Event.ON_RESUME))
        assertFalse(request.lifecycle(Lifecycle.Event.ON_RESUME))
    }

    @Test fun resumeBeforePermissionResultDoesNotLoseRequest() {
        val request = VoicePermissionRequest()
        request.handsFree()
        assertFalse(request.resume())
        request.result(true)
        assertTrue(request.resume())
    }

    @Test fun denialOrLeavingScreenCancelsHandsFree() {
        for (denied in listOf(false, true)) {
            val request = VoicePermissionRequest()
            request.handsFree()
            if (denied) request.result(false) else { request.lifecycle(Lifecycle.Event.ON_STOP); request.result(true) }
            assertFalse(request.resume())
        }
    }

    @Test fun pushToTalkGrantNeverStartsHandsFree() {
        val request = VoicePermissionRequest()
        request.result(true)
        assertFalse(request.resume())
    }
}
