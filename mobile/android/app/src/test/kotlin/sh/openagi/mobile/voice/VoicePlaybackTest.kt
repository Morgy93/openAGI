package sh.openagi.mobile.voice

import org.junit.Assert.*
import org.junit.Test

class VoicePlaybackTest {
    @Test fun queuedAndWrittenAudioIsNotAcknowledgedUntilFullyPlayed() {
        val playback = VoicePlayback()
        var heard = 0
        playback.append(24000)
        playback.complete(500.0) { heard++ }
        assertTrue(playback.played(0).isEmpty())
        assertTrue(playback.played(11999).isEmpty())
        playback.played(12000).forEach { it() }
        assertEquals(1, heard)
        assertTrue(playback.played(12001).isEmpty())
    }

    @Test fun bargeMeasuresOnlyCurrentItemAndDropsPendingAcknowledgements() {
        var playback = VoicePlayback()
        playback.append(24000)
        playback.complete(500.0) { fail("Interrupted reply acknowledged") }
        assertEquals(125L, playback.playedMs(3000))
        playback = VoicePlayback()
        assertTrue(playback.played(12000).isEmpty())
        playback.append(48000)
        playback.complete(1000.0) {}
        playback.played(24000).forEach { it() }
        playback.append(24000)
        assertEquals(125L, playback.playedMs(27000))
    }

    @Test fun consecutiveRepliesHaveSeparateCompletionBoundaries() {
        val playback = VoicePlayback()
        val heard = mutableListOf<String>()
        playback.append(24000)
        playback.complete(500.0) { heard.add("first") }
        playback.append(12000)
        playback.complete(250.0) { heard.add("second") }
        playback.played(12000).forEach { it() }
        assertEquals(listOf("first"), heard)
        assertEquals(0L, playback.playedMs(12000))
        playback.played(18000).forEach { it() }
        assertEquals(listOf("first", "second"), heard)
    }

    @Test fun missingAudioAndDuplicateDoneNeverAcknowledge() {
        val playback = VoicePlayback()
        playback.complete(500.0) { fail("No audio acknowledged") }
        playback.append(12000)
        playback.complete(500.0) { fail("Missing audio acknowledged") }
        playback.complete(250.0) { fail("Duplicate done acknowledged") }
        assertTrue(playback.played(24000).isEmpty())
    }

    @Test fun fractionalMillisecondsWaitForTheLastFrame() {
        val playback = VoicePlayback()
        playback.append(6024)
        playback.complete(125.5) {}
        assertTrue(playback.played(3011).isEmpty())
        assertEquals(1, playback.played(3012).size)
    }

    @Test fun audioAlreadyPlayedStillNeedsReplyDoneBeforeAcknowledgement() {
        val playback = VoicePlayback()
        playback.append(24000)
        assertTrue(playback.played(12000).isEmpty())
        playback.complete(500.0) {}
        assertEquals(1, playback.played(12000).size)
    }
}
