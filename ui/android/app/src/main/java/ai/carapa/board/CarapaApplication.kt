package ai.carapa.board

import android.app.Application

class CarapaApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // Process-wide, so [CarapaMessagingService] gets the same TLS trust as the activity.
        CarapaTls.init(this)
    }
}
