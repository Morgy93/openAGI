package sh.openagi.mobile.ui

import androidx.lifecycle.Lifecycle

internal class VoicePermissionRequest {
    private var pendingHandsFree = false
    private var granted = false

    fun handsFree() { pendingHandsFree = true; granted = false }
    fun result(allowed: Boolean) {
        granted = allowed
        if (!allowed) cancel()
    }
    fun resume(): Boolean {
        if (!pendingHandsFree || !granted) return false
        cancel()
        return true
    }
    fun lifecycle(event: Lifecycle.Event): Boolean {
        if (event == Lifecycle.Event.ON_STOP) cancel()
        return event == Lifecycle.Event.ON_RESUME && resume()
    }
    fun cancel() { pendingHandsFree = false; granted = false }
}
