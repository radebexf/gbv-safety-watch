package com.gbvsafetywatch

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

/**
 * Main entry Activity for the GBV Safety Watch app.
 *
 * Hosts the React Native root view. The component name returned by
 * [getMainComponentName] must match the name registered in index.js
 * via AppRegistry.registerComponent (the app's "name" in app.json).
 */
class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript.
   * This is used to schedule rendering of the component.
   */
  override fun getMainComponentName(): String = "GBVSafetyWatch"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use
   * [DefaultReactActivityDelegate] which allows enabling New Architecture
   * with a single boolean flag [fabricEnabled].
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
