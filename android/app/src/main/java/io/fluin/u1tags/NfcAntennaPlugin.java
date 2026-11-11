package io.fluin.u1tags;

import android.nfc.AvailableNfcAntenna;
import android.nfc.NfcAdapter;
import android.nfc.NfcAntennaInfo;
import android.os.Build;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Reports where the phone's NFC antenna is, from Android 14's NfcAntennaInfo, so the app can show
 * people exactly where to hold a tag. Resolves an empty object when the phone doesn't say.
 */
@CapacitorPlugin(name = "NfcAntenna")
public class NfcAntennaPlugin extends Plugin {

    @PluginMethod
    public void getInfo(PluginCall call) {
        JSObject result = new JSObject();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            call.resolve(result);
            return;
        }
        NfcAdapter adapter = NfcAdapter.getDefaultAdapter(getContext());
        NfcAntennaInfo info = adapter == null ? null : adapter.getNfcAntennaInfo();
        if (info == null || info.getDeviceWidth() <= 0 || info.getDeviceHeight() <= 0) {
            call.resolve(result);
            return;
        }

        // Millimeters, measured from the top-left corner with the screen facing the user.
        result.put("deviceWidth", info.getDeviceWidth());
        result.put("deviceHeight", info.getDeviceHeight());
        result.put("foldable", info.isDeviceFoldable());
        JSArray antennas = new JSArray();
        for (AvailableNfcAntenna antenna : info.getAvailableNfcAntennas()) {
            JSObject spot = new JSObject();
            spot.put("x", antenna.getLocationX());
            spot.put("y", antenna.getLocationY());
            antennas.put(spot);
        }
        result.put("antennas", antennas);
        call.resolve(result);
    }
}
