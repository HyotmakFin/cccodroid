package cc.codroid;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.Build;
import android.os.Process;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;
import rikka.shizuku.Shizuku;

/**
 * 经 Shizuku 提权（以 shell 身份 uid 2000 执行命令）。
 *
 * 为什么绕一圈：Shizuku 的 binder 只在本应用的 Java 进程里，而终端里跑的 priv 是普通子进程（bash/node），
 * 拿不到 binder。所以本进程开一个本地套接字当中转：
 *
 *   priv 'cmd'（应用 uid 的子进程）→ 抽象命名空间套接字 "cc.codroid.priv"
 *     → 本类（核对对端 uid 必须是本应用自己）→ Shizuku.newProcess → shell 身份执行
 *
 * 安全：抽象套接字谁都能连，所以每个连接先查 SO_PEERCRED —— 不是本应用 uid 的一律断开，
 * 别的应用借不到这份权限。
 *
 * 协议（一问一答）：客户端先发一行 JSON 请求；
 *   op=exec 之后双向走帧：[1 字节类型][4 字节长度 BE][数据]
 *     客户端 → 0=stdin（长度 0 表示 EOF）
 *     服务端 → 1=stdout 2=stderr 3=退出码(4 字节) 4=错误文本
 *   其余 op 回一行 JSON。
 */
final class Priv {
    static final String TAG = "cccodroid-priv";
    static final String SOCKET = "cc.codroid.priv";
    static final String MANAGER = "moe.shizuku.privileged.api";
    static final int REQ = 7331;

    private static Context ctx;
    private static volatile boolean started;
    private static volatile String lastPermission = "";

    static synchronized void start(Context c) {
        if (started) return;
        started = true;
        ctx = c.getApplicationContext();
        Shizuku.addBinderReceivedListenerSticky(() -> {
            Log.i(TAG, "Shizuku binder 到手 uid=" + safeUid());
            if (prefs().getBoolean("keepalive", false) && granted()) {
                new Thread(() -> keepAlive(true), "keepalive").start();
            }
        });
        Shizuku.addBinderDeadListener(() -> Log.w(TAG, "Shizuku binder 断了"));
        Shizuku.addRequestPermissionResultListener((code, result) -> {
            lastPermission = result == PackageManager.PERMISSION_GRANTED ? "granted" : "denied";
            ShizukuSetup.get(ctx).onPermission(result == PackageManager.PERMISSION_GRANTED);
            if (result == PackageManager.PERMISSION_GRANTED && prefs().getBoolean("keepalive", false)) {
                new Thread(() -> keepAlive(true), "keepalive").start();
            }
        });
        new Thread(Priv::serve, "priv-server").start();
    }

    private static SharedPreferences prefs() { return ctx.getSharedPreferences("priv", Context.MODE_PRIVATE); }

    // ── 状态 ───────────────────────────────────────────────────────────
    static boolean installed() {
        try { ctx.getPackageManager().getPackageInfo(MANAGER, 0); return true; }
        catch (Exception e) { return false; }
    }
    static boolean running() {
        try { return Shizuku.pingBinder(); } catch (Throwable t) { return false; }
    }
    static boolean granted() {
        try { return running() && !Shizuku.isPreV11() && Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED; }
        catch (Throwable t) { return false; }
    }
    /**
     * 实测：真起一个进程跑 id -u。Shizuku 客户端库会缓存"已授权"（在 Shizuku 里撤销后我们这边不刷新），
     * 设置页显示的"已就绪"以它为准。结果缓存 10 秒，设置页 1.5 秒一轮的刷新不至于狂起进程。
     */
    private static volatile long verifiedAt;
    private static volatile boolean verifiedOk;
    static boolean verified() {
        if (!granted()) return false;
        if (System.currentTimeMillis() - verifiedAt < 10_000) return verifiedOk;
        boolean ok;
        try {
            java.lang.Process p = newProcess(new String[]{"id", "-u"}, null, "/");
            p.getOutputStream().close();
            String out = new String(readAll(p.getInputStream()), StandardCharsets.UTF_8).trim();
            ok = p.waitFor() == 0 && (out.equals("2000") || out.equals("0"));
        } catch (Throwable t) { ok = false; }
        verifiedOk = ok; verifiedAt = System.currentTimeMillis();
        return ok;
    }

    private static int safeUid() { try { return Shizuku.getUid(); } catch (Throwable t) { return -1; } }

    static JSONObject status() throws Exception {
        JSONObject o = new JSONObject();
        boolean ins = installed(), run = ins && running(), ok = run && verified();
        o.put("state", !ins ? "not_installed" : !run ? "not_running" : !ok ? "no_permission" : "ok");
        o.put("installed", ins);
        o.put("running", run);
        o.put("granted", ok);
        if (run) {
            try { o.put("version", Shizuku.getVersion()); } catch (Throwable ignored) {}
            o.put("uid", safeUid());     // 2000 = adb 方式启动，0 = root 方式
        }
        o.put("keepalive", prefs().getBoolean("keepalive", false));
        o.put("lastPermission", lastPermission);
        ShizukuSetup.get(ctx).put(o);
        SharedPreferences bg = ctx.getSharedPreferences("bg", Context.MODE_PRIVATE);
        o.put("frozen", new JSONObject().put("at", bg.getLong("frozenAt", 0)).put("ms", bg.getLong("frozenMs", 0))
            .put("count", bg.getInt("frozenCount", 0)).put("vendor", Build.MANUFACTURER.toLowerCase(java.util.Locale.ROOT)));
        return o;
    }

    // ── 执行 ───────────────────────────────────────────────────────────
    /** Shizuku.newProcess 在 13.x 里是 private（官方想让人改用 UserService），
     *  但它正是 rish 用的那条路，最直接；反射拿出来用。 */
    private static java.lang.Process newProcess(String[] argv, String[] envp, String dir) throws Exception {
        Method m = Shizuku.class.getDeclaredMethod("newProcess", String[].class, String[].class, String.class);
        m.setAccessible(true);
        return (java.lang.Process) m.invoke(null, argv, envp, dir);
    }

    /** 跑一条命令拿全部输出（内部用：保活设置） */
    static String run(String cmd) {
        try {
            java.lang.Process p = newProcess(new String[]{"/system/bin/sh", "-c", cmd + " 2>&1"}, null, "/");
            p.getOutputStream().close();
            String out = new String(readAll(p.getInputStream()), StandardCharsets.UTF_8).trim();
            int rc = p.waitFor();
            return (rc == 0 ? "" : "[rc=" + rc + "] ") + out;
        } catch (Throwable t) {
            return "[失败] " + t;
        }
    }

    static final String STAGE = "/data/local/tmp/cccodroid-update.apk", STAGE_LOG = "/data/local/tmp/cccodroid-update.log";

    /**
     * 静默装自己的新版本。两步走，因为 pm 替换本应用时会杀掉本进程，而 Shizuku 会跟着杀掉本进程开的子进程：
     *   1. 把 APK 流式写到 /data/local/tmp（shell 读不到本应用私有目录，那里它能读写）；
     *   2. setsid 起一个脱离的 shell 去 pm install，装完由它把后台服务拉起来（不靠 MY_PACKAGE_REPLACED ——
     *      国产 ROM 的自启动管理会把这条广播拦掉，实测红魔 SKIPPED）；界面原本开着就把界面也拉起来。
     *      红魔连 shell 起服务都拦（"Blocked by AutoLaunch"），但拉界面不拦：服务起不来时由 shell 发一条通知，点开即恢复。
     * @return 走到返回说明还活着：多半没装上，返回 pm 的输出
     */
    static String pipeInstall(java.io.File apk, boolean reopenUi, String version) {
        try {
            java.lang.Process p = newProcess(new String[]{"sh", "-c", "cat > " + STAGE + " && chmod 644 " + STAGE}, null, "/");
            try (InputStream in = new java.io.FileInputStream(apk); OutputStream o = p.getOutputStream()) {
                byte[] buf = new byte[1 << 16];
                for (int n; (n = in.read(buf)) > 0; ) o.write(buf, 0, n);
            }
            if (p.waitFor() != 0) return "[失败] 写不进 " + STAGE;
            String pkg = ctx.getPackageName();
            // 带点击动作的通知有的 ROM 不让 shell 发（红魔：getIntentSender 权限不足），失败就发纯文字的
            String note = "cmd notification post -t \"cccodroid 已更新到 v" + version + "（系统不让它在后台自己启动）\"";
            String job = "pm install -r " + STAGE + " > " + STAGE_LOG + " 2>&1; rm -f " + STAGE + "; "
                + "am start-foreground-service -n " + pkg + "/.GatewayService >> " + STAGE_LOG + " 2>&1"
                + (reopenUi ? "; am start -n " + pkg + "/.MainActivity >> " + STAGE_LOG + " 2>&1"
                   : "; grep -q Error " + STAGE_LOG + " && { " + note + " -c \"activity -n " + pkg + "/.MainActivity\" cccodroid-updated \"点此打开即可继续使用\""
                     + " || " + note + " cccodroid-updated \"打开 cccodroid 即可继续使用\"; } >> " + STAGE_LOG + " 2>&1");
            run("setsid sh -c '" + job + "' < /dev/null > /dev/null 2>&1 &");
            Thread.sleep(60_000);       // 装上的话本进程在这期间就没了
            return run("cat " + STAGE_LOG);
        } catch (Throwable t) {
            return "[失败] " + t;
        }
    }

    // ── 后台保活增强 ─────────────────────────────────────────────────────
    /**
     * 安卓 12+ 的"幽灵进程"限制：所有应用的子进程合计超过 32 个就开始杀 —— claude、bash、node、
     * 编译器全是子进程，一次并行构建就可能被收割。另有电池白名单、后台运行限制、待机分组。
     * 这些都要 shell 权限才改得动，所以放在 Shizuku 后面，并且只在用户点了开关之后做。
     */
    static JSONObject keepAlive(boolean on) {
        JSONObject r = new JSONObject();
        prefs().edit().putBoolean("keepalive", on).apply();
        if (!granted()) { try { r.put("ok", false).put("message", "Shizuku 未就绪或未授权"); } catch (Exception ignored) {} return r; }
        String pkg = ctx.getPackageName();
        String[][] steps = on ? new String[][]{
            {"幽灵进程上限", "device_config set_sync_disabled_for_tests persistent; device_config put activity_manager max_phantom_processes 2147483647"},
            {"关闭幽灵进程监控", "settings put global settings_enable_monitor_phantom_procs false"},
            {"电池白名单", "dumpsys deviceidle whitelist +" + pkg},
            {"允许后台运行", "cmd appops set " + pkg + " RUN_IN_BACKGROUND allow; cmd appops set " + pkg + " RUN_ANY_IN_BACKGROUND allow"},
            {"待机分组设为活跃", "am set-standby-bucket " + pkg + " active"},
        } : new String[][]{
            {"恢复幽灵进程上限", "device_config delete activity_manager max_phantom_processes; device_config set_sync_disabled_for_tests none"},
            {"恢复幽灵进程监控", "settings delete global settings_enable_monitor_phantom_procs"},
        };
        try {
            JSONArray arr = new JSONArray();
            for (String[] s : steps) arr.put(new JSONObject().put("step", s[0]).put("out", run(s[1])));
            r.put("ok", true).put("steps", arr);
            if (on) r.put("phantom", run("device_config get activity_manager max_phantom_processes"));
        } catch (Exception ignored) {}
        Log.i(TAG, "保活增强 " + (on ? "开" : "关") + "：" + r);
        return r;
    }

    // ── 套接字服务 ───────────────────────────────────────────────────────
    private static void serve() {
        LocalServerSocket ss;
        try { ss = new LocalServerSocket(SOCKET); }
        catch (IOException e) { Log.e(TAG, "开不了套接字", e); return; }
        int me = Process.myUid();
        while (true) {
            try {
                LocalSocket s = ss.accept();
                int peer = s.getPeerCredentials().getUid();
                if (peer != me) {
                    Log.w(TAG, "拒绝外来连接 uid=" + peer);
                    s.close();
                    continue;
                }
                new Thread(() -> handle(s), "priv-conn").start();
            } catch (IOException e) {
                Log.e(TAG, "accept 出错", e);
            }
        }
    }

    private static void handle(LocalSocket s) {
        try (LocalSocket sock = s) {
            InputStream in = sock.getInputStream();
            OutputStream out = sock.getOutputStream();
            JSONObject req = new JSONObject(readLine(in));
            String op = req.optString("op");
            JSONObject resp;
            switch (op) {
                case "exec": {
                    Thread stdin = exec(req, in, out);
                    // 只关写方向，再等客户端自己关。直接 close 的话，客户端还没送完的 stdin 帧留在我们这边没读，
                    // 它下一次写就是 EPIPE —— Node 遇到写错误会当场销毁套接字，连已经到手的输出和退出码一起丢掉。
                    try { sock.shutdownOutput(); } catch (IOException ignored) {}
                    if (stdin != null) stdin.join(5000);
                    else drain(sock, in);
                    return;
                }
                case "status": resp = status(); break;
                case "request":
                    if (!running()) resp = new JSONObject().put("ok", false).put("message", "Shizuku 没在运行");
                    else if (granted()) resp = new JSONObject().put("ok", true).put("message", "已授权");
                    else { lastPermission = "pending"; Shizuku.requestPermission(REQ); resp = new JSONObject().put("ok", true).put("message", "已弹出授权请求"); }
                    break;
                case "open_manager": {
                    Intent i = ctx.getPackageManager().getLaunchIntentForPackage(MANAGER);
                    if (i != null) { i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); ctx.startActivity(i); }
                    resp = new JSONObject().put("ok", i != null);
                    break;
                }
                case "keepalive": resp = keepAlive(req.optBoolean("enable", true)); break;
                case "freeze_ack": ctx.getSharedPreferences("bg", Context.MODE_PRIVATE).edit().clear().apply(); resp = status(); break;
                case "open_app_settings": {      // 自启动、悬浮窗之类的开关都在应用详情页里
                    ctx.startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:" + ctx.getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                    resp = new JSONObject().put("ok", true);
                    break;
                }
                case "usb_list": resp = Usb.list(ctx); break;
                // 一键安装 / 激活 Shizuku（ShizukuSetup），进度在 status 的 setup 字段里
                case "shz_install": ShizukuSetup.get(ctx).install(false); resp = status(); break;
                case "shz_activate": ShizukuSetup.get(ctx).activate(); resp = status(); break;
                case "shz_pair": ShizukuSetup.get(ctx).onCode(req.optString("code")); resp = status(); break;
                case "shz_repair": ShizukuSetup.get(ctx).repair(); resp = status(); break;
                case "shz_autostart": ShizukuSetup.get(ctx).setAutostart(req.optBoolean("enable", true)); resp = status(); break;
                // 更新（Updater）
                case "upd_status": resp = Updater.get(ctx).status(); break;
                case "upd_check": Updater.get(ctx).checkAsync(true); resp = Updater.get(ctx).status(); break;
                case "upd_apply": resp = Updater.get(ctx).apply(req.optString("item"), true); break;
                case "upd_set": Updater.get(ctx).set(req); resp = Updater.get(ctx).status(); break;
                case "usb_open": Usb.open(ctx, req, sock); return;   // 自己回复（fd 随回复走）
                default: resp = new JSONObject().put("ok", false).put("message", "未知操作 " + op);
            }
            out.write((resp.toString() + "\n").getBytes(StandardCharsets.UTF_8));
            out.flush();
        } catch (Throwable t) {
            Log.e(TAG, "处理请求出错", t);
        }
    }

    /** 返回负责转发 stdin 的线程（它在客户端关闭时结束）；没起进程就返回 null */
    private static Thread exec(JSONObject req, InputStream in, OutputStream rawOut) throws Exception {
        DataOutputStream out = new DataOutputStream(rawOut);
        if (!granted()) {
            frame(out, 4, (installed() ? (running() ? "Shizuku 还没授权给 cccodroid（设置 → Shizuku 里点授权）" : "Shizuku 没在运行，先打开 Shizuku 启动服务")
                : "没装 Shizuku（https://shizuku.rikka.app/）").getBytes(StandardCharsets.UTF_8));
            frameExit(out, 126);
            return null;
        }
        JSONArray a = req.getJSONArray("argv");
        String[] argv = new String[a.length()];
        for (int i = 0; i < argv.length; i++) argv[i] = a.getString(i);
        String[] envp = null;
        JSONObject e = req.optJSONObject("env");
        if (e != null) {
            envp = new String[e.length()];
            java.util.Iterator<String> it = e.keys();
            for (int i = 0; it.hasNext(); i++) { String k = it.next(); envp[i] = k + "=" + e.getString(k); }
        }
        String dir = req.optString("cwd", "/");
        java.lang.Process p;
        try { p = newProcess(argv, envp, dir); }
        catch (Throwable t) { frame(out, 4, ("起进程失败：" + t).getBytes(StandardCharsets.UTF_8)); frameExit(out, 127); return null; }

        Thread o1 = pump(p.getInputStream(), out, 1);
        Thread o2 = pump(p.getErrorStream(), out, 2);
        // 客户端 → 进程 stdin
        Thread inT = new Thread(() -> {
            DataInputStream din = new DataInputStream(in);
            OutputStream pin = p.getOutputStream();
            try {
                while (true) {
                    int type = din.read();
                    if (type < 0) break;
                    int len = din.readInt();
                    if (len == 0) break;
                    byte[] b = new byte[len];
                    din.readFully(b);
                    if (type == 0) { pin.write(b); pin.flush(); }
                }
            } catch (IOException ignored) {
            } finally {
                try { pin.close(); } catch (IOException ignored) {}
            }
        }, "priv-stdin");
        inT.setDaemon(true);
        inT.start();
        int rc = p.waitFor();
        o1.join(); o2.join();
        frameExit(out, rc);
        return inT;
    }

    /** 把客户端还在发的东西读干净，直到它关闭（最多等 5 秒） */
    private static void drain(LocalSocket sock, InputStream in) {
        try {
            sock.setSoTimeout(5000);
            byte[] b = new byte[4096];
            while (in.read(b) >= 0) { }
        } catch (IOException ignored) {}
    }

    private static Thread pump(InputStream src, DataOutputStream out, int type) {
        Thread t = new Thread(() -> {
            byte[] buf = new byte[16384];
            try {
                for (int n; (n = src.read(buf)) > 0; ) synchronized (out) { out.writeByte(type); out.writeInt(n); out.write(buf, 0, n); out.flush(); }
            } catch (IOException ignored) {}
        }, "priv-out" + type);
        t.start();
        return t;
    }

    private static void frame(DataOutputStream out, int type, byte[] b) throws IOException {
        synchronized (out) { out.writeByte(type); out.writeInt(b.length); out.write(b); out.flush(); }
    }
    private static void frameExit(DataOutputStream out, int rc) throws IOException {
        synchronized (out) { out.writeByte(3); out.writeInt(4); out.writeInt(rc); out.flush(); }
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        for (int c; (c = in.read()) >= 0 && c != '\n'; ) b.write(c);
        return b.toString("UTF-8");
    }
    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        for (int n; (n = in.read(buf)) > 0; ) b.write(buf, 0, n);
        return b.toByteArray();
    }
}
