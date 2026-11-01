package com.clipcascade

import java.util.UUID

/** Process-lifetime ownership. Process death also destroys every old JS run. */
object ServiceRunRegistry {
    private var owner: String? = null
    private var stopping = false
    private var activated = false

    @Synchronized fun currentId(): String? = owner

    @Synchronized fun claim(): String? {
        if (owner != null) return null
        owner = UUID.randomUUID().toString()
        stopping = false
        activated = false
        return owner
    }

    @Synchronized fun activate(id: String): Boolean {
        if (owner != id || activated) return false
        activated = true
        return true
    }

    @Synchronized fun isCurrent(id: String): Boolean = owner == id && !stopping

    @Synchronized fun stop(id: String): Boolean {
        if (owner != id) return false
        stopping = true
        return true
    }

    @Synchronized fun <T> withOwner(id: String, action: () -> T): T? =
        if (owner == id) action() else null

    @Synchronized fun <T> withIdle(action: () -> T): T? =
        if (owner == null) action() else null

    @Synchronized fun release(id: String): Boolean {
        if (owner != id) return false
        owner = null
        return true
    }
}
