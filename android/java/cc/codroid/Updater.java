package cc.codroid;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.os.StatFs;
import android.system.Os;
import android.util.Log;
import java.io.File;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 三样东西的更新：应用本体（APK）、开发工具包（devkit）、官方 Claude Code。默认自动。
 *
 *   Claude Code：装进新的版本目录再切 current 指针 —— 正在跑的 claude 用的还是旧文件，不受影响，所以全程静默。
 *                （它自带的自动更新被 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC 关了，而且也不认我们的目录布局。）
 *   APK：下载、核对签名与本应用一致。有 Shizuku 且空闲、界面不在前台时静默装；否则发通知，点一下走系统安装确认。
 *   工具包：约 600 MB，会替换整个 $PREFIX。自动模式只在不计流量的网络上预先下载；
 *           下次冷启动且没有任务在跑时替换（或用户在设置页点"安装"）。用户自装进 $PREFIX 的东西会搬过去。
 *
 * 版本来源：GitHub Releases（v* 是 APK，devkit-* 是工具包）；Claude Code 走官方 downloads.claude.ai。
 */
final class Updater {
    static final String TAG = "cccodroid-upd";
    static final String REPO = "greyoak111/cccodroid";
    /** 工具包与本 APK 的接口版本：lock.json 里的 compat（缺省 1）对不上就不装，防止新工具包配旧外壳 */
    static final int DEVKIT_COMPAT = 1;
    static final String CH = "updates";
    static final long AUTO_EVERY = 6 * 3600_000L;

    private static Updater inst;
    static synchronized Updater get(Context c) { if (inst == null) inst = new Updater(c.getApplicationContext()); return inst; }

    final Context ctx;
    final Env env;
    private final Item app = new Item("app", "cccodroid"), devkit = new Item("devkit", "开发工具包"), claude = new Item("claude", "Claude Code");
    private volatile boolean checking;
    private volatile String lastError = "";

    static final class Item {
        final String id, name;
        volatile String current = "", latest = "", state = "unknown", message = "";
        volatile long done, total;
        // 下载需要的东西
        volatile String url, sha, base;
        volatile long size, need;
        volatile File file;
        Item(String id, String name) { this.id = id; this.name = name; }
        JSONObject json() throws Exception {
            return new JSONObject().put("id", id).put("name", name).put("current", current).put("latest", latest)
                .put("state", state).put("message", message).put("done", done).put("total", total);
        }
        void set(String st, String msg) { state = st; message = msg == null ? "" : msg; Log.i(TAG, id + " → " + st + " " + message); }
    }

    private Updater(Context c) {
        ctx = c;
        env = new Env(c);
        NotificationChannel ch = new NotificationChannel(CH, "更新", NotificationManager.IMPORTANCE_DEFAULT);
        ch.setDescription("新版本已下载、等你点一下安装");
        c.getSystemService(NotificationManager.class).createNotificationChannel(ch);
        refreshCurrent();
        // 上次下好、还没装的工具包（进程重启后状态在内存里没了，靠这条记录接上）
        try {
            JSONObject st = new JSONObject(prefs().getString("devkitStaged", "{}"));
            File f = new File(st.optString("file", "/nonexistent"));
            if (f.isFile() && f.length() == st.optLong("size")) {
                devkit.file = f; devkit.base = st.getString("base"); devkit.sha = st.getString("sha256");
                devkit.size = st.getLong("size"); devkit.url = devkit.base + f.getName(); devkit.latest = tagOf(devkit.base);
                devkit.set("ready", "");
            }
        } catch (Exception ignored) {}
    }

    SharedPreferences prefs() { return ctx.getSharedPreferences("upd", Context.MODE_PRIVATE); }
    boolean auto() { return prefs().getBoolean("auto", true); }
    String channel() { return prefs().getString("channel", "stable"); }

    // ── 状态 ───────────────────────────────────────────────────────────
    JSONObject status() throws Exception {
        refreshCurrent();
        // 结果只在内存里：进程重启后第一次有人来看（打开设置页）就顺手查一次（只查，不自动装）
        if (!checking && "unknown".equals(app.state) && "unknown".equals(claude.state)) checkAsync(true);
        JSONArray a = new JSONArray();
        for (Item i : new Item[]{app, devkit, claude}) a.put(i.json());
        return new JSONObject().put("ok", true).put("auto", auto()).put("channel", channel())
            .put("lastCheck", prefs().getLong("lastCheck", 0)).put("checking", checking).put("error", lastError).put("items", a);
    }

    void set(JSONObject req) {
        SharedPreferences.Editor e = prefs().edit();
        if (req.has("auto")) e.putBoolean("auto", req.optBoolean("auto", true));
        String ch = req.optString("channel", "");
        if (ch.equals("stable") || ch.equals("latest")) e.putString("channel", ch);
        e.apply();
    }

    private void refreshCurrent() {
        try { app.current = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionName; } catch (Exception ignored) {}
        devkit.current = tagOf(installedDevkitBase());
        try { claude.current = new File(Os.readlink(new File(env.home, ".local/share/cccodroid/claude/current").getPath())).getName(); }
        catch (Exception e) { claude.current = ""; }
    }

    /** 已装工具包来自哪个 Release 目录。早期版本只写了 "ok"：那就是本 APK 内置地址里那一版 */
    String installedDevkitBase() {
        JSONObject o = env.devkitInfo();
        String b = o.optString("base", "");
        return b.isEmpty() ? pinnedDevkitBase() : b;
    }
    private String installedDevkitSha() { return env.devkitInfo().optString("sha256", ""); }
    private String pinnedDevkitBase() {
        try (java.io.InputStream in = ctx.getAssets().open("devkit-sources.txt")) {
            return new String(readAll(in), StandardCharsets.UTF_8).trim().split("\\s+")[0];
        } catch (Exception e) { return ""; }
    }
    static String tagOf(String base) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("/download/([^/]+)/?$").matcher(base == null ? "" : base);
        return m.find() ? m.group(1) : "";
    }

    // ── 检查 ───────────────────────────────────────────────────────────
    /** 后台线程里跑。manual=true：用户点的"检查更新"——只查不自动装大件；auto 模式下顺带按规则自动下载/安装 */
    void checkAsync(boolean manual) {
        if (checking) return;
        checking = true;
        new Thread(() -> {
            try { check(manual); } finally { checking = false; }
        }, "upd-check").start();
    }

    private void check(boolean manual) {
        lastError = "";
        refreshCurrent();
        JSONArray rels = null;
        try { rels = new JSONArray(new String(Installer.httpGetSmall(feed()), StandardCharsets.UTF_8)); }
        catch (Exception e) { lastError = "连不上 GitHub：" + e.getMessage(); app.set("error", lastError); devkit.set("error", lastError); }
        if (rels != null) {
            try { checkApp(rels); } catch (Exception e) { app.set("error", e.getMessage()); }
            try { checkDevkit(rels); } catch (Exception e) { devkit.set("error", e.getMessage()); }
        }
        try { checkClaude(); } catch (Exception e) { claude.set("error", "连不上 downloads.claude.ai：" + e.getMessage()); }
        prefs().edit().putLong("lastCheck", System.currentTimeMillis()).apply();
        if (auto() && !manual) autoApply();
    }

    private void checkApp(JSONArray rels) throws Exception {
        for (int i = 0; i < rels.length(); i++) {
            JSONObject r = rels.getJSONObject(i);
            String tag = r.optString("tag_name");
            if (r.optBoolean("draft") || !tag.matches("v\\d+(\\.\\d+)*")) continue;
            app.latest = tag.substring(1);
            if (cmpVer(app.latest, app.current) <= 0) { app.set("uptodate", ""); return; }
            JSONArray as = r.getJSONArray("assets");
            for (int k = 0; k < as.length(); k++) {
                JSONObject a = as.getJSONObject(k);
                if (!a.optString("name").equals("cccodroid.apk")) continue;
                app.url = a.getString("browser_download_url");
                app.size = a.optLong("size");
                String d = a.optString("digest", "");
                app.sha = d.startsWith("sha256:") ? d.substring(7) : null;
                app.file = new File(env.files, "updates/cccodroid-" + app.latest + ".apk");
                if (!"downloading".equals(app.state) && !"installing".equals(app.state))
                    app.set(app.file.isFile() && app.file.length() == app.size ? "ready" : "available", r.optBoolean("prerelease") ? "预览版" : "");
                return;
            }
            app.set("error", "v" + app.latest + " 里没有 cccodroid.apk");
            return;
        }
        app.set("uptodate", "");
    }

    private void checkDevkit(JSONArray rels) throws Exception {
        String best = null;
        for (int i = 0; i < rels.length(); i++) {
            JSONObject r = rels.getJSONObject(i);
            String tag = r.optString("tag_name");
            if (r.optBoolean("draft") || !tag.startsWith("devkit-")) continue;
            if (best == null || cmpVer(tag.substring(7), best.substring(7)) > 0) best = tag;
        }
        if (best == null) { devkit.set("uptodate", ""); return; }
        devkit.latest = best;
        String base = "https://github.com/" + REPO + "/releases/download/" + best + "/";
        JSONObject lock = new JSONObject(new String(Installer.httpGetSmall(base + "devkit.lock.json"), StandardCharsets.UTF_8));
        if (!ctx.getPackageName().equals(lock.optString("target")) || lock.optInt("compat", 1) != DEVKIT_COMPAT) {
            devkit.set("uptodate", best + " 需要更新版本的 cccodroid"); return;
        }
        JSONObject gz = lock.getJSONObject("gz");
        String sha = gz.getString("sha256");
        String have = installedDevkitSha();
        if (have.isEmpty() ? best.equals(devkit.current) : have.equals(sha)) { devkit.set("uptodate", ""); return; }
        devkit.base = base; devkit.sha = sha; devkit.size = gz.getLong("bytes");
        JSONObject tar = lock.optJSONObject("tar");
        devkit.need = tar != null ? tar.optLong("bytes") : devkit.size * 4;
        devkit.url = base + gz.getString("file");
        devkit.file = new File(env.files, gz.getString("file"));
        if (!"downloading".equals(devkit.state) && !"installing".equals(devkit.state))
            devkit.set(devkit.file.isFile() && devkit.file.length() == devkit.size ? "ready" : "available",
                String.format(java.util.Locale.ROOT, "%.0f MB", devkit.size / 1048576.0));
    }

    private void checkClaude() throws Exception {
        String v = new String(Installer.httpGetSmall("https://downloads.claude.ai/claude-code-releases/" + channel()), StandardCharsets.UTF_8).trim();
        if (!v.matches("\\d+\\.\\d+\\.\\d+.*")) throw new IOException("版本号不对：" + v);
        claude.latest = v;
        if (!"installing".equals(claude.state))
            claude.set(cmpVer(v, claude.current) <= 0 ? "uptodate" : "available", channel().equals("latest") ? "latest 渠道" : "");
    }

    /** 发布列表地址。home/.config/cccodroid/update-feed 里写了地址就用它（测试更新流程用，形状同 GitHub API） */
    private String feed() {
        File f = new File(env.home, ".config/cccodroid/update-feed");
        try { if (f.isFile()) { String u = new String(java.nio.file.Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8).trim(); if (!u.isEmpty()) return u; } }
        catch (Exception ignored) {}
        return "https://api.github.com/repos/" + REPO + "/releases?per_page=30";
    }

    /** 自动模式的规则：见类注释 */
    private void autoApply() {
        boolean unmetered = !ctx.getSystemService(ConnectivityManager.class).isActiveNetworkMetered();
        if ("available".equals(claude.state) && unmetered) apply("claude", false);
        if ("available".equals(app.state)) apply("app", false);              // 几 MB，什么网都下
        else if ("ready".equals(app.state)) maybeSilentInstallApp();
        if ("available".equals(devkit.state) && unmetered) apply("devkit", false);
        else if ("ready".equals(devkit.state)) notifyReady(devkit);
    }

    /** 后台定时：服务起来 20 秒后、之后每 30 分钟看一眼，距上次检查超过 6 小时就查 */
    void loop() {
        new Thread(() -> {
            sleep(20_000);
            while (true) {
                if (auto() && System.currentTimeMillis() - prefs().getLong("lastCheck", 0) > AUTO_EVERY) checkAsync(false);
                sleep(30 * 60_000L);
            }
        }, "upd-loop").start();
    }

    // ── 应用更新 ─────────────────────────────────────────────────────────
    /** @param user 用户点的（或从通知点进来的）：APK 就走安装确认；工具包就去替换 */
    JSONObject apply(String id, boolean user) {
        Item it = id.equals("app") ? app : id.equals("devkit") ? devkit : id.equals("claude") ? claude : null;
        JSONObject r = new JSONObject();
        try {
            if (it == null) return r.put("ok", false).put("message", "未知项 " + id);
            if ("downloading".equals(it.state) || "installing".equals(it.state)) return r.put("ok", true).put("message", "进行中");
            if (it == claude) {
                if (claude.latest.isEmpty()) return r.put("ok", false).put("message", "先检查更新");
                new Thread(this::installClaude, "upd-claude").start();
                return r.put("ok", true).put("message", "开始更新 Claude Code");
            }
            if (it.url == null) return r.put("ok", false).put("message", "没有可用的更新，先检查");
            if ("ready".equals(it.state)) {
                if (it == app) { new Thread(this::installApp, "upd-install").start(); return r.put("ok", true).put("message", "正在安装"); }
                if (user) { new Thread(this::startDevkitApply, "upd-devkit").start(); return r.put("ok", true).put("message", "正在替换开发工具包"); }
                return r.put("ok", true).put("message", "已下载，等待安装");
            }
            new Thread(() -> download(it, user), "upd-dl-" + id).start();
            return r.put("ok", true).put("message", "开始下载");
        } catch (Exception e) {
            try { r.put("ok", false).put("message", e.getMessage()); } catch (Exception ignored) {}
            return r;
        }
    }

    private Installer installer(Item it) {
        return new Installer(env, new Installer.Progress() {
            public void step(String m) { Log.i(TAG, it.id + ": " + m); if (m.startsWith("  网络中断")) it.message = m.trim(); }
            public void bytes(long d, long t) { it.done = d; it.total = t; }
        });
    }

    private void download(Item it, boolean user) {
        it.set("downloading", "");
        it.done = 0; it.total = it.size;
        try {
            if (it == devkit) {
                long need = it.size + (it.need > 0 ? it.need : it.size * 4) + (300L << 20);   // gz + 解出来的新目录（旧目录换名前一直在）+ 余量
                long free = new StatFs(env.files.getPath()).getAvailableBytes();
                if (free < need) throw new IOException(String.format(java.util.Locale.ROOT, "空间不够：需要约 %.1f GB，只剩 %.1f GB", need / 1e9, free / 1e9));
            }
            installer(it).download(it.url, it.file, it.size, it.sha);
            if (it == app) checkApkSigner(it.file);
            if (it == devkit) prefs().edit().putString("devkitStaged", new JSONObject().put("file", it.file.getPath())
                .put("base", it.base).put("sha256", it.sha).put("size", it.size).toString()).apply();
            it.set("ready", "");
            if (it == app) { if (user) installApp(); else maybeSilentInstallApp(); }
            else if (user) startDevkitApply();
            else notifyReady(it);
        } catch (Exception e) {
            if (it == app && it.file != null) it.file.delete();
            it.set("error", e.getMessage());
        }
    }

    /** 下载来的 APK 必须是本应用、同一把签名钥匙。签名不同系统本来也拒装，这里先挡住，免得弹一个必失败的确认框 */
    private void checkApkSigner(File apk) throws Exception {
        PackageManager pm = ctx.getPackageManager();
        PackageInfo a = Apk.archiveInfo(ctx, apk);
        if (a == null || !ctx.getPackageName().equals(a.packageName)) throw new IOException("下载的不是 cccodroid 安装包");
        if (!Apk.signer(a).equals(Apk.signer(pm.getPackageInfo(ctx.getPackageName(), Apk.SIG_FLAGS))))
            throw new IOException("安装包签名与本应用不一致，拒绝安装");
    }

    void installApp() {
        if (app.file == null || !app.file.isFile()) { app.set("error", "安装包不见了，重新检查更新"); return; }
        app.set("installing", "");
        // 有 Shizuku 就静默装（进程会被系统替换掉，服务由 MY_PACKAGE_REPLACED 拉起）；否则走系统安装确认
        if (Priv.granted() && !gatewayBusy()) {
            String out = Priv.pipeInstall(app.file, MainActivity.visible, app.latest);
            Log.i(TAG, "pm install → " + out);     // 走到这里多半说明没装上（装上的话本进程已经没了）
            if (!out.contains("Success")) app.set("ready", "静默安装失败（" + out + "），点安装走系统确认");
            return;
        }
        try { Apk.install(ctx, app.file, "app"); }
        catch (Exception e) { app.set("error", "安装失败：" + e.getMessage()); }
    }

    /** 自动模式：Shizuku 可用、没有任务在跑、界面不在前台 —— 静默装；否则通知用户 */
    private void maybeSilentInstallApp() {
        if (Priv.granted() && !gatewayBusy() && !MainActivity.visible) installApp();
        else notifyReady(app);
    }

    void onInstallResult(String what, boolean ok, String msg) {
        Item it = "app".equals(what) ? app : null;
        if (it == null) return;
        it.set(ok ? "uptodate" : "ready", ok ? "" : msg);
    }

    private void installClaude() {
        claude.set("installing", "");
        claude.done = 0; claude.total = 0;
        try {
            int rc = installer(claude).run(env.bin("bash").getPath(), new File(env.app, "scripts/install-claude.sh").getPath(), claude.latest);
            refreshCurrent();
            if (rc != 0) throw new IOException("install-claude.sh 返回 " + rc);
            claude.set("uptodate", "已更新到 " + claude.current + "（下一轮对话起生效）");
        } catch (Exception e) { claude.set("error", e.getMessage()); }
    }

    // ── 工具包替换 ───────────────────────────────────────────────────────
    boolean devkitStaged() { return "ready".equals(devkit.state) && devkit.file != null && devkit.file.isFile(); }

    /** 交给界面做：替换期间网关要停，界面切回安装进度页 */
    private void startDevkitApply() {
        if (gatewayBusy()) { devkit.set("ready", "有任务正在跑，等它结束再装"); return; }
        ctx.startActivity(new Intent(ctx, MainActivity.class).setAction(MainActivity.ACTION_APPLY_DEVKIT).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    /** 在 MainActivity 的线程里调。ins 的进度打到安装界面 */
    void applyDevkit(Installer ins) throws Exception {
        devkit.set("installing", "");
        GatewayService.pause(true);
        try {
            for (int i = 0; i < 40 && pingGateway(); i++) Thread.sleep(250);
            ins.installDevkit(devkit.file.getPath(), devkit.base, devkit.sha);
            devkit.file.delete();
            prefs().edit().remove("devkitStaged").apply();
            refreshCurrent();
            devkit.set("uptodate", "");
            ctx.getSystemService(NotificationManager.class).cancel(20);
        } catch (Exception e) {
            devkit.set("error", e.getMessage());
            throw e;
        } finally {
            GatewayService.pause(false);
        }
    }

    // ── 通知 ───────────────────────────────────────────────────────────
    private void notifyReady(Item it) {
        String text = it == app ? "新版本 v" + app.latest + " 已下载，点此安装"
            : "开发工具包 " + devkit.latest + " 已下载。点此安装（约 1–2 分钟，期间暂停服务）；不点的话下次打开应用且空闲时自动装";
        PendingIntent pi = PendingIntent.getActivity(ctx, it == app ? 21 : 22,
            new Intent(ctx, MainActivity.class).setAction(MainActivity.ACTION_UPDATE).putExtra("item", it.id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(ctx, CH)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle(it.name + " 有更新")
            .setContentText(text)
            .setStyle(new Notification.BigTextStyle().bigText(text))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build();
        ctx.getSystemService(NotificationManager.class).notify(it == app ? 21 : 20, n);
    }

    // ── 小工具 ───────────────────────────────────────────────────────────
    static boolean pingGateway() {
        try {
            HttpURLConnection c = Env.gateway("/api/status");
            c.setConnectTimeout(800); c.setReadTimeout(1500);
            return c.getResponseCode() == 200;
        } catch (Exception e) { return false; }
    }

    /** 网关在跑任务（或排着队）吗。问不到就当忙，宁可不打断 */
    static boolean gatewayBusy() {
        try {
            HttpURLConnection c = Env.gateway("/api/status");
            c.setConnectTimeout(800); c.setReadTimeout(3000);
            if (c.getResponseCode() != 200) return true;
            JSONObject o = new JSONObject(new String(readAll(c.getInputStream()), StandardCharsets.UTF_8));
            return o.optBoolean("busy") || o.optInt("queued") > 0;
        } catch (Exception e) { return pingGateway(); }      // 网关没起来 = 不忙；起着却问不清 = 当忙
    }

    /** 1.2.10 > 1.2.9；非数字段忽略 */
    static int cmpVer(String a, String b) {
        String[] x = a.split("[^0-9]+"), y = b.split("[^0-9]+");
        for (int i = 0; i < Math.max(x.length, y.length); i++) {
            long p = i < x.length && !x[i].isEmpty() ? Long.parseLong(x[i]) : 0, q = i < y.length && !y[i].isEmpty() ? Long.parseLong(y[i]) : 0;
            if (p != q) return p < q ? -1 : 1;
        }
        return 0;
    }

    static byte[] readAll(java.io.InputStream in) throws IOException {
        java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        for (int r; (r = in.read(buf)) > 0; ) b.write(buf, 0, r);
        return b.toByteArray();
    }
    private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) {} }
}
