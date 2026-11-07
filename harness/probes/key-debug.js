// key-debug.js — Diagnostic: print every Key event value to chat + file.
// RUN ONCE from jsMacros GUI. It logs every key press so we can see
// what ev.key contains for the 'P' key (and others).
// ---------------------------------------------------------------------------

var LOG_FILE = "config/jsMacros/Macros/key_debug.log";
var writer = null;

try {
    var f = new java.io.File(LOG_FILE);
    f.getParentFile().mkdirs();
    writer = new java.io.BufferedWriter(new java.io.FileWriter(f, true));
} catch (e) {
    Chat.log("[KeyDebug] Cannot open log: " + e);
}

function logKey(msg) {
    Chat.log("[KeyDebug] " + msg);
    try {
        if (writer) {
            writer.write(msg);
            writer.newLine();
            writer.flush();
        }
    } catch (e) {}
}

logKey("=== KeyDebug started ===");
var lastKey = null;

var listener = JsMacros.on("Key", JavaWrapper.methodToJava(function (ev) {
    try {
        var key = ev.key;
        var action = ev.action; // 1 = press, 0 = release (if available)
        var txt = "key=" + key + " action=" + action;
        if (key !== lastKey) {
            logKey(txt);
            lastKey = key;
        }
    } catch (e) {
        logKey("ERROR: " + String(e));
    }
}));

logKey("Listener registered. Press P (and other keys) to see values.");
logKey("To stop: run 'JsMacros.getServiceManager().stopService(JsMacros.getServiceManager().getServiceForEvent(\'Key\').get(0))' or reload.");
