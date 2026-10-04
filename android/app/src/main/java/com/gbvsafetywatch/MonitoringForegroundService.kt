package com.gbvsafetywatch

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * MonitoringForegroundService
 *
 * Keeps the safety-monitoring process alive while the screen is off by running
 * as an Android foreground service of type "health" (Requirements 9.1, 9.5).
 *
 * This is the native host for the long-running monitoring loop. The actual
 * monitoring logic (BLE, heart rate, anomaly detection, alert dispatch) runs in
 * the React Native JS layer (src/service/MonitoringService.ts); this service's
 * job is simply to hold a foreground notification so the OS does not kill the
 * process. It is started/stopped from JS when the user activates/deactivates
 * monitoring.
 */
class MonitoringForegroundService : Service() {

  companion object {
    private const val CHANNEL_ID = "gbv_monitoring"
    private const val CHANNEL_NAME = "Safety Monitoring"
    private const val NOTIFICATION_ID = 4701

    const val ACTION_START = "com.gbvsafetywatch.action.START_MONITORING"
    const val ACTION_STOP = "com.gbvsafetywatch.action.STOP_MONITORING"
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        stopForegroundCompat()
        stopSelf()
        return START_NOT_STICKY
      }
      else -> startForegroundWithNotification()
    }
    // START_STICKY asks the OS to recreate the service after it is killed,
    // supporting the auto-resume requirement (9.5).
    return START_STICKY
  }

  private fun startForegroundWithNotification() {
    createNotificationChannel()

    val notification: Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("GBV Safety Watch")
            .setContentText("Safety monitoring is active")
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      // Android 14+ requires declaring the foreground service type explicitly.
      startForeground(
          NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel =
          NotificationChannel(
              CHANNEL_ID,
              CHANNEL_NAME,
              NotificationManager.IMPORTANCE_LOW,
          )
      channel.description = "Persistent notification shown while safety monitoring is active."
      val manager = getSystemService(NotificationManager::class.java)
      manager?.createNotificationChannel(channel)
    }
  }

  @Suppress("DEPRECATION")
  private fun stopForegroundCompat() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      stopForeground(true)
    }
  }
}
