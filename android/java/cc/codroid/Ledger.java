package cc.codroid;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;

/**
 * 修复账本：每次自检、修复、安装、启动时的恢复，各记一行 JSON（时间、做了什么、发现什么、结果）。
 * 出了问题时不用猜"它之前干过什么"——设置页能直接翻，一键分享日志也会带上。
 * 一行一条（JSONL），只留最近 200 条。
 */
final class Ledger {
    private static final int KEEP = 200;
    private static final Object LOCK = new Object();

    private Ledger() {}

    static File file(Env env) { return new File(env.files, "ledger.jsonl"); }

    /** kind：verify / repair / install / recover / safe-mode；ok：结果；msg：一句人话；detail：可选的细节 */
    static void add(Env env, String kind, boolean ok, String msg, JSONObject detail) {
        try {
            JSONObject e = new JSONObject()
                .put("at", System.currentTimeMillis()).put("kind", kind).put("ok", ok).put("msg", msg);
            if (detail != null) e.put("detail", detail);
            synchronized (LOCK) {
                File f = file(env);
                try (FileOutputStream o = new FileOutputStream(f, true)) {
                    o.write((e + "\n").getBytes(StandardCharsets.UTF_8));
                }
                if (f.length() > 256 * 1024) {
                    List<String> lines = Files.readAllLines(f.toPath(), StandardCharsets.UTF_8);
                    if (lines.size() > KEEP) Files.write(f.toPath(), lines.subList(lines.size() - KEEP, lines.size()), StandardCharsets.UTF_8);
                }
            }
            Log.i("cccodroid-ledger", e.toString());
        } catch (Exception ex) { Log.w("cccodroid-ledger", "记账失败: " + ex); }
    }

    /** 最近 n 条，新的在前 */
    static JSONArray recent(Env env, int n) {
        JSONArray out = new JSONArray();
        try {
            List<String> lines = Files.readAllLines(file(env).toPath(), StandardCharsets.UTF_8);
            for (int i = lines.size() - 1; i >= 0 && out.length() < n; i--) {
                try { out.put(new JSONObject(lines.get(i))); } catch (Exception ignored) {}
            }
        } catch (Exception ignored) {}
        return out;
    }
}
