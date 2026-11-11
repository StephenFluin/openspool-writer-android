package io.fluin.u1tags;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NfcAntennaPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
