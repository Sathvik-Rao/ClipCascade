package com.clipcascade

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig


class HeadlessTaskService : HeadlessJsTaskService() {

    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
        return intent?.extras?.let {
            HeadlessJsTaskConfig(
                "Restart", // JS task name
                Arguments.fromBundle(it), // Data passed to the task
                5000, // Timeout for the task
                true // Allow task to run in foreground
            )
        }
    } 
}
