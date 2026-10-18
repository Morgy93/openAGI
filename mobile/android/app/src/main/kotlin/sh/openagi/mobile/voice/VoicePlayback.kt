package sh.openagi.mobile.voice

// Frame counts come from queued PCM and the player's playback head, not a timer.
class VoicePlayback(private val rate: Int = 24000) {
    private data class Reply(val end: Long, val onPlayed: () -> Unit)
    private val replies = ArrayDeque<Reply>()
    private var queued = 0L
    private var itemStart = 0L
    private var nextItem = true

    fun append(bytes: Int) {
        if (nextItem) { itemStart = queued; nextItem = false }
        queued += bytes / 2
    }

    fun complete(audioMs: Double, onPlayed: () -> Unit) {
        if (nextItem) return
        // Missing audio must never qualify as a fully heard reply.
        if (queued - itemStart >= audioMs * rate / 1000 - 0.000001) replies.addLast(Reply(queued, onPlayed))
        nextItem = true
    }

    fun played(head: Long): List<() -> Unit> {
        val callbacks = mutableListOf<() -> Unit>()
        while (replies.isNotEmpty() && head >= replies.first().end) callbacks.add(replies.removeFirst().onPlayed)
        return callbacks
    }

    fun playedMs(head: Long): Long = (head - itemStart).coerceIn(0, queued - itemStart) * 1000 / rate
}
