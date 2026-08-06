// android\app\src\main\java\com\clipcascade\MainApplication.kt
package com.clipcascade

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.modules.network.CustomClientBuilder
import com.facebook.react.modules.network.OkHttpClientFactory
import com.facebook.react.modules.network.OkHttpClientProvider
import com.facebook.react.modules.websocket.WebSocketModule
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.soloader.SoLoader

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost =
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> =
            PackageList(this).packages.apply {
              add(ClipboardListenerPackage())
              add(NativeBridgePackage())
            }

        override fun getJSMainModuleName(): String = "index"

        override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

        override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
        override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED
      }

  override val reactHost: ReactHost
    get() = getDefaultReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    SoLoader.init(this, OpenSourceMergedSoMapping)
    if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
      load()
    }
    installTrustManager()
  }

  /**
   * Routes both of React Native's networking paths through [ClipCascadeTrustManager].
   *
   * They need separate hooks: fetch() takes its client from OkHttpClientProvider,
   * while WebSocket (the STOMP broker and the P2P signaling socket) builds a client
   * of its own and only honours the CustomClientBuilder hook. Wiring just the first
   * one would let login succeed while clipboard sync never connects.
   *
   * Runs in onCreate so the boot receiver and the headless service get the same
   * trust configuration as the UI process.
   */
  private fun installTrustManager() {
    ClipCascadeTrustManager.reload(this)
    val socketFactory = ClipCascadeTrustManager.sslSocketFactory()

    OkHttpClientProvider.setOkHttpClientFactory(
        OkHttpClientFactory {
          OkHttpClientProvider.createClientBuilder(this@MainApplication)
              .sslSocketFactory(socketFactory, ClipCascadeTrustManager)
              .build()
        })

    WebSocketModule.setCustomClientBuilder(
        CustomClientBuilder { builder ->
          builder.sslSocketFactory(socketFactory, ClipCascadeTrustManager)
        })
  }
}
