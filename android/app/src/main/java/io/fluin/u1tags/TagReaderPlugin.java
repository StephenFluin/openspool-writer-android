package io.fluin.u1tags;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.nfc.FormatException;
import android.nfc.NdefMessage;
import android.nfc.NdefRecord;
import android.nfc.NfcAdapter;
import android.nfc.Tag;
import android.nfc.TagLostException;
import android.nfc.tech.Ndef;
import android.nfc.tech.NdefFormatable;
import android.nfc.tech.NfcA;
import android.nfc.tech.TagTechnology;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONException;

/**
 * Android tag access: reader mode, tag events, and raw NFC-A and NDEF operations on the exact tag an
 * event reported. It replaces @capgo/capacitor-nfc's scanning on Android, whose events are retained
 * and replayed to later listeners, whose commands go to whichever tag came last, and whose stale
 * connections throw out of its tag callback. Here every call settles; a tag that has gone rejects
 * with code TAG_LOST, and NFC turned off rejects with DISABLED.
 */
@CapacitorPlugin(name = "TagReader")
public class TagReaderPlugin extends Plugin {

    private static final String TAG = "TagReader";
    /** NFC-A for NTAGs, MIFARE and bank cards; NFC-V so ISO 15693 tags can be named as incompatible. */
    private static final int READER_FLAGS = NfcAdapter.FLAG_READER_NFC_A | NfcAdapter.FLAG_READER_NFC_V;
    private static final int PRESENCE_CHECK_DELAY_MS = 250;
    /** Reader mode stays on this long after a scan, so a tag being lifted away isn't handed to the system. */
    private static final long GRACE_MS = 10_000;
    /** Right after a resume or NFC coming back on, NfcService may refuse reader mode, so it's asked again. */
    private static final long[] REARM_DELAYS_MS = { 0, 400, 1500 };
    /** Tags kept for later commands; older ones are forgotten. */
    private static final int KEPT_TAGS = 8;
    private static final String CONNECT_BUSY = "Only one TagTechnology can be connected at a time.";

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AtomicInteger nextTagId = new AtomicInteger();
    private final Map<Integer, Tag> tags = new ConcurrentHashMap<>();
    private final Map<Integer, JSObject> infos = new ConcurrentHashMap<>();

    /** Guards the hand-off between a scan starting and a tag arriving between scans. */
    private final Object sessionLock = new Object();
    /** The scan in progress, or 0 between scans. Events are only sent during a scan. */
    private volatile int session = 0;
    /** A tag that arrived between scans (during the grace period) and went to nobody. Guarded by sessionLock. */
    private int unclaimedTagId = -1;

    /** True during a scan and its grace period. Only written on the main thread. */
    private volatile boolean readerWanted = false;
    private boolean stateReceiverRegistered = false;

    private final Runnable enableReader = this::enableReader;
    private final Runnable graceOver = () -> {
        readerWanted = false;
        disableReader();
    };

    // Only touched on the io thread.
    private TagTechnology connection;
    private int connectionTagId = -1;

    private final BroadcastReceiver nfcState = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            int state = intent.getIntExtra(NfcAdapter.EXTRA_ADAPTER_STATE, NfcAdapter.STATE_OFF);
            if (state == NfcAdapter.STATE_ON) {
                // NfcService drops reader mode when NFC turns off, and only an activity resume restores it.
                if (readerWanted) rearm();
            } else if (state == NfcAdapter.STATE_TURNING_OFF || state == NfcAdapter.STATE_OFF) {
                int current = session;
                if (current != 0) {
                    JSObject event = new JSObject();
                    event.put("session", current);
                    notifyListeners("disabled", event, false);
                }
            }
        }
    };

    @Override
    public void load() {
        // Sent by the NFC service, which runs as a separate app, so the receiver must be exported.
        ContextCompat.registerReceiver(
            getContext(),
            nfcState,
            new IntentFilter(NfcAdapter.ACTION_ADAPTER_STATE_CHANGED),
            ContextCompat.RECEIVER_EXPORTED
        );
        stateReceiverRegistered = true;
    }

    @PluginMethod
    public void start(PluginCall call) {
        NfcAdapter adapter = adapter();
        if (adapter == null) {
            call.reject("This device has no NFC reader.", "UNSUPPORTED");
            return;
        }
        if (!adapter.isEnabled()) {
            call.reject("NFC is turned off.", "DISABLED");
            return;
        }
        int id = call.getInt("session", 0);
        int reuseTagId = call.getInt("reuseTagId", -1);
        int candidate;
        synchronized (sessionLock) {
            session = id;
            // A retry reuses the tag that just failed; any scan picks up a tag that arrived between
            // scans, since reader mode won't report either again while it stays in the field.
            candidate = reuseTagId >= 0 ? reuseTagId : unclaimedTagId;
            unclaimedTagId = -1;
        }
        main.post(() -> {
            main.removeCallbacks(graceOver);
            readerWanted = true;
            enableReader();
        });
        if (candidate >= 0) {
            runIo(() -> {
                if (session == id && isPresent(candidate)) emit(id, candidate);
            });
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        synchronized (sessionLock) {
            session = 0;
        }
        runIo(this::closeConnection);
        main.post(() -> {
            main.removeCallbacks(graceOver);
            main.postDelayed(graceOver, GRACE_MS);
        });
        call.resolve();
    }

    @PluginMethod
    public void transceive(PluginCall call) {
        int tagId = call.getInt("tagId", -1);
        Integer timeout = call.getInt("timeout");
        byte[] frame;
        try {
            frame = bytes(call.getArray("data"));
        } catch (IllegalArgumentException e) {
            call.reject(e.getMessage(), "INVALID");
            return;
        }
        boolean queued = runIo(() -> {
            try {
                NfcA nfcA = nfcA(tagId);
                if (timeout != null) nfcA.setTimeout(timeout);
                JSObject result = new JSObject();
                result.put("response", array(nfcA.transceive(frame)));
                call.resolve(result);
            } catch (Exception e) {
                // Closing also resets a tag that refused the command, so the next command can reach it.
                closeConnection();
                reject(call, e);
            }
        });
        if (!queued) call.reject("The NFC reader has shut down.", "FAILED");
    }

    @PluginMethod
    public void writeNdef(PluginCall call) {
        int tagId = call.getInt("tagId", -1);
        boolean format = Boolean.TRUE.equals(call.getBoolean("format", false));
        byte[] bytes;
        try {
            bytes = bytes(call.getArray("message"));
        } catch (IllegalArgumentException e) {
            call.reject(e.getMessage(), "INVALID");
            return;
        }
        boolean queued = runIo(() -> {
            closeConnection();
            TagTechnology tech = null;
            try {
                Tag tag = tag(tagId);
                NdefMessage message = new NdefMessage(bytes);
                Ndef ndef = Ndef.get(tag);
                if (ndef != null) {
                    tech = ndef;
                    connectOrLost(ndef);
                    if (!ndef.isWritable()) {
                        call.reject("Tag is read only.", "READ_ONLY");
                        return;
                    }
                    if (ndef.getMaxSize() < bytes.length) {
                        call.reject("Tag capacity is insufficient.", "TOO_SMALL");
                        return;
                    }
                    ndef.writeNdefMessage(message);
                } else {
                    NdefFormatable formatable = format ? NdefFormatable.get(tag) : null;
                    if (formatable == null) {
                        call.reject("Tag does not support NDEF.", "NOT_NDEF");
                        return;
                    }
                    tech = formatable;
                    connectOrLost(formatable);
                    formatable.format(message);
                }
                call.resolve();
            } catch (Exception e) {
                // An I/O failure partway through is usually the tag leaving; tell the two apart.
                closeQuietly(tech);
                tech = null;
                boolean gone = e instanceof IOException && !(e instanceof TagLostException) && !isPresent(tagId);
                reject(call, gone ? lost(e) : e);
            } finally {
                // Always released, so raw commands can follow on the same tag.
                closeQuietly(tech);
            }
        });
        if (!queued) call.reject("The NFC reader has shut down.", "FAILED");
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (readerWanted) rearm();
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        main.removeCallbacks(enableReader);
        disableReader();
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        main.removeCallbacks(enableReader);
        main.removeCallbacks(graceOver);
        if (stateReceiverRegistered) {
            try {
                getContext().unregisterReceiver(nfcState);
            } catch (IllegalArgumentException ignored) {
                // Already unregistered.
            }
            stateReceiverRegistered = false;
        }
        io.shutdownNow();
    }

    private void onTagDiscovered(Tag tag) {
        int id = nextTagId.incrementAndGet();
        JSObject info;
        try {
            info = describe(id, tag);
        } catch (Exception e) {
            Logger.warn(TAG, "Couldn't describe tag: " + e.getMessage());
            return;
        }
        tags.put(id, tag);
        infos.put(id, info);
        tags.keySet().removeIf((key) -> key <= id - KEPT_TAGS);
        infos.keySet().removeIf((key) -> key <= id - KEPT_TAGS);
        int current;
        synchronized (sessionLock) {
            current = session;
            if (current == 0) unclaimedTagId = id;
        }
        if (current != 0) emit(current, id);
    }

    private void emit(int session, int tagId) {
        JSObject info = infos.get(tagId);
        if (info == null) return;
        JSObject event = new JSObject();
        event.put("session", session);
        event.put("tag", info);
        // Not retained: an event nobody is listening for is dropped rather than replayed later.
        notifyListeners("tag", event, false);
    }

    /** Everything Android learned about the tag when it was discovered; no I/O. */
    private static JSObject describe(int id, Tag tag) throws JSONException {
        JSObject info = new JSObject();
        info.put("tagId", id);
        info.put("id", array(tag.getId()));
        JSArray techs = new JSArray();
        for (String tech : tag.getTechList()) techs.put(tech);
        info.put("techTypes", techs);
        Ndef ndef = Ndef.get(tag);
        if (ndef != null) {
            info.put("type", friendlyType(ndef.getType()));
            info.put("maxSize", ndef.getMaxSize());
            info.put("isWritable", ndef.isWritable());
            NdefMessage cached = ndef.getCachedNdefMessage();
            if (cached != null) {
                JSArray records = new JSArray();
                for (NdefRecord record : cached.getRecords()) {
                    JSObject entry = new JSObject();
                    entry.put("tnf", record.getTnf());
                    entry.put("type", array(record.getType()));
                    entry.put("id", array(record.getId()));
                    entry.put("payload", array(record.getPayload()));
                    records.put(entry);
                }
                info.put("ndefMessage", records);
            }
        }
        return info;
    }

    private static String friendlyType(String type) {
        if (type == null) return null;
        switch (type) {
            case Ndef.NFC_FORUM_TYPE_1:
                return "NFC Forum Type 1";
            case Ndef.NFC_FORUM_TYPE_2:
                return "NFC Forum Type 2";
            case Ndef.NFC_FORUM_TYPE_3:
                return "NFC Forum Type 3";
            case Ndef.NFC_FORUM_TYPE_4:
                return "NFC Forum Type 4";
            case Ndef.MIFARE_CLASSIC:
                return "MIFARE Classic";
            default:
                return null;
        }
    }

    /** Whether the tag still answers, checked by connecting (which re-selects it). Only on the io thread. */
    private boolean isPresent(int tagId) {
        closeConnection();
        Tag tag = tags.get(tagId);
        NfcA nfcA = tag == null ? null : NfcA.get(tag);
        if (nfcA == null) return false;
        try {
            nfcA.connect();
            return true;
        } catch (Exception e) {
            return false;
        } finally {
            closeQuietly(nfcA);
        }
    }

    private NfcA nfcA(int tagId) throws IOException {
        if (connection instanceof NfcA && connectionTagId == tagId && isConnected(connection)) return (NfcA) connection;
        closeConnection();
        NfcA nfcA = NfcA.get(tag(tagId));
        if (nfcA == null) throw new UnsupportedOperationException("This isn't an NFC-A tag.");
        connectOrLost(nfcA);
        connection = nfcA;
        connectionTagId = tagId;
        return nfcA;
    }

    /** connect() does no radio I/O on these tags, so failing means NFC is off or the tag has gone. */
    private void connectOrLost(TagTechnology tech) throws IOException {
        try {
            tech.connect();
        } catch (IOException e) {
            if (CONNECT_BUSY.equals(e.getMessage())) throw e;
            NfcAdapter adapter = adapter();
            if (adapter != null && !adapter.isEnabled()) throw new NfcOffException(e);
            throw lost(e);
        }
    }

    private static TagLostException lost(Exception cause) {
        TagLostException lost = new TagLostException("The tag is no longer in range.");
        lost.initCause(cause);
        return lost;
    }

    private Tag tag(int tagId) throws TagLostException {
        Tag tag = tags.get(tagId);
        if (tag == null) throw new TagLostException("That tag is no longer available.");
        return tag;
    }

    private void closeConnection() {
        closeQuietly(connection);
        connection = null;
        connectionTagId = -1;
    }

    /** Closing a technology on a tag that has gone throws SecurityException, not just IOException. */
    private static void closeQuietly(TagTechnology tech) {
        if (tech == null) return;
        try {
            if (tech.isConnected()) tech.close();
        } catch (Exception ignored) {
            // The tag is gone; there is nothing left to release.
        }
    }

    private static boolean isConnected(TagTechnology tech) {
        try {
            return tech.isConnected();
        } catch (Exception e) {
            return false;
        }
    }

    /** Runs on the io thread; false once the plugin has been destroyed. */
    private boolean runIo(Runnable task) {
        try {
            io.execute(task);
            return true;
        } catch (RejectedExecutionException e) {
            return false;
        }
    }

    private void rearm() {
        main.removeCallbacks(enableReader);
        for (long delay : REARM_DELAYS_MS) main.postDelayed(enableReader, delay);
    }

    private void enableReader() {
        Activity activity = getActivity();
        NfcAdapter adapter = adapter();
        if (activity == null || adapter == null || !readerWanted) return;
        Bundle extras = new Bundle();
        extras.putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, PRESENCE_CHECK_DELAY_MS);
        try {
            adapter.enableReaderMode(activity, this::onTagDiscovered, READER_FLAGS, extras);
        } catch (Exception e) {
            Logger.warn(TAG, "Couldn't turn on reader mode: " + e.getMessage());
        }
    }

    private void disableReader() {
        Activity activity = getActivity();
        NfcAdapter adapter = adapter();
        if (activity == null || adapter == null) return;
        try {
            adapter.disableReaderMode(activity);
        } catch (Exception e) {
            Logger.warn(TAG, "Couldn't turn off reader mode: " + e.getMessage());
        }
    }

    private NfcAdapter adapter() {
        return NfcAdapter.getDefaultAdapter(getContext());
    }

    private static void reject(PluginCall call, Exception e) {
        String code;
        if (e instanceof NfcOffException) {
            code = "DISABLED";
        } else if (e instanceof TagLostException || e instanceof SecurityException) {
            // Includes a command the tag ignored: Android can't tell silence from a tag that left.
            code = "TAG_LOST";
        } else if (e instanceof IOException) {
            // Includes a tag refusing a command (NAK).
            code = "IO";
        } else if (e instanceof FormatException) {
            code = "FORMAT";
        } else if (e instanceof UnsupportedOperationException) {
            code = "UNSUPPORTED_TAG";
        } else {
            code = "FAILED";
        }
        String message = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
        call.reject(message, code, e);
    }

    private static byte[] bytes(JSArray array) {
        if (array == null || array.length() == 0) throw new IllegalArgumentException("Expected a non-empty byte array.");
        byte[] bytes = new byte[array.length()];
        for (int i = 0; i < bytes.length; i++) {
            int value = array.optInt(i, -1);
            if (value < 0 || value > 255) throw new IllegalArgumentException("Byte values must be 0-255.");
            bytes[i] = (byte) value;
        }
        return bytes;
    }

    private static JSArray array(byte[] bytes) {
        JSArray array = new JSArray();
        if (bytes != null) for (byte b : bytes) array.put(b & 0xff);
        return array;
    }

    private static final class NfcOffException extends IOException {

        NfcOffException(Throwable cause) {
            super("NFC is turned off.", cause);
        }
    }
}
