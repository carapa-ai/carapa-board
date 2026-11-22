package ai.carapa.board

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import com.getcapacitor.BridgeActivity
import ee.forgr.capacitor_updater.CapacitorUpdaterPlugin

class MainActivity : BridgeActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        // The install marker must be handled before the first WebView
        // navigation. Register the updater ahead of CarapaBridge so its native
        // state is initialized when the bridge plugin consumes the marker.
        registerPlugin(CapacitorUpdaterPlugin::class.java)
        registerPlugin(CarapaBridgePlugin::class.java)
        registerPlugin(CarapaWhisperPlugin::class.java)
        registerPlugin(CarapaDeviceTtsPlugin::class.java)
        super.onCreate(savedInstanceState)
        CarapaTls.installWebViewClient(this.bridge)
        deliverIfNotifTap(intent)

        // On Android 11+ (API 30+) the WebView resizes correctly with
        // ADJUST_RESIZE. On older Androids, ADJUST_RESIZE causes Chromium
        // WebView to collapse the layout viewport to ~36 px when the IME
        // opens, so we use ADJUST_NOTHING and apply a JS-side workaround.
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
        } else {
            WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING
        }
        window.setSoftInputMode(mode)

        this.bridge.getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        deliverIfNotifTap(intent)
    }

    private fun deliverIfNotifTap(intent: Intent?) {
        val notifId = intent?.getStringExtra(CarapaMessagingService.EXTRA_NOTIF_ID) ?: return
        CarapaBridgePlugin.deliverNotifTap(notifId)
        // Clear so a subsequent onNewIntent without an extra doesn't re-fire.
        intent.removeExtra(CarapaMessagingService.EXTRA_NOTIF_ID)
    }
}
