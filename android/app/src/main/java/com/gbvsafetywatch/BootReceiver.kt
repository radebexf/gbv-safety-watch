package com.gbvsafetywatch

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * BootReceiver
 *
 * Restarts the monitoring foreground service after a device reboot so that
 * safety monitoring resumes automatically if it was active at shutdown
 * (Requirement 9.5).
 *
 * The JS layer persists whether monitoring was active (gbv.monitoring_session).
 * On boot this receiver optimistically starts the foreground service; the JS
 * layer reconciles actual state on next launch and stops the service if the
 * user had deactivated monitoring.
 */
class BootReceiver : BroadcastReceiver() {

  companion object {
    private const val TAG = "GBVBootReceiver"
  }

  override fun onReceive(context: Context, intent: Intent) {
    val action = intent.action
    if (action == Intent.ACTION_BOOT_COMPLETED ||
        action == "android.intent.action.QUICKBOOT_POWERON") {
      Log.i(TAG, "Boot completed — starting monitoring service")

      val serviceIntent =
          Intent(context, MonitoringForegroundService::class.java).apply {
            setAction(MonitoringForegroundService.ACTION_START)
          }

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(serviceIntent)
      } else {
        context.startService(serviceIntent)
      }
    }
  }
}
