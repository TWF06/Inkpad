package app.inkpad.notes;

import android.content.pm.ActivityInfo;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NotesFolderPlugin.class);
        // the app opens horizontally; once it's up, it turns with the tablet (vertical works too)
        if (savedInstanceState == null) {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
            new Handler(Looper.getMainLooper()).postDelayed(() -> setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_FULL_USER), 2000);
        }
        super.onCreate(savedInstanceState);
    }
}
