package cc.codroid;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.CountDownLatch;

/**
 * 启动流程：存储权限 → 开发工具包 → 官方 Claude Code → 网关代码 → 前台服务 → 界面。
 * 每一步都能重入：装到一半被杀，下次打开从缺的那一步接着来。
 */
public class MainActivity extends Activity {
    /** 本地工具包（离线安装 / 开发期）：放在共享目录就优先用它；下载地址见 assets/devkit-sources.txt */
    static final String[] LOCAL_DEVKIT = {
        "/sdcard/cccodroid/devkit-cc.codroid.tar.gz", "/sdcard/cccodroid/devkit-cc.codroid.tar",
    };

    static final String ACTION_APPLY_DEVKIT = "cc.codroid.APPLY_DEVKIT";
    static final String ACTION_UPDATE = "cc.codroid.UPDATE";
    static final String ACTION_SHIZUKU = "cc.codroid.SHIZUKU";
    /** 配对通知的 fullScreenIntent：只为让通知常驻顶部，真被拉起（锁屏时）也什么都不做 */
    static final String ACTION_SHIZUKU_NOOP = "cc.codroid.SHIZUKU_NOOP";
    /** 界面在前台吗：自动静默更新只在用户没盯着界面时做 */
    static volatile boolean visible;

    private Env env;
    private volatile boolean booted;
    private Intent pending;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private TextView log;
    private ScrollView logScroll;
    private ProgressBar bar;
    private TextView stat;
    private WebView web;
    /** 宽屏时嵌在右侧工作区的浏览器（null = 没开）。位置、显隐全听页面的（layout.js → CCApp.paneBounds） */
    private BrowserPane pane;
    private volatile boolean paneCanBack;
    private ValueCallback<Uri[]> fileCb;
    /** 「保存到」：等系统文件面板回来时要复制的源文件。static：挑位置期间界面被回收重建也还在 */
    private static File savePending;
    /** 安装失败时露出来；点了从头再走 boot（每一步都会跳过已经完成的部分） */
    private android.widget.Button retry, stuck;

    @Override protected void onCreate(Bundle b) {
        // 安装页、空白 WebView 都按界面里选的外观（浅 / 深 / 跟随系统）上色，别再"界面浅色、启动页深色"
        setTheme(uiDark() ? android.R.style.Theme_Material_NoActionBar : android.R.style.Theme_Material_Light_NoActionBar);
        super.onCreate(b);
        env = new Env(this);
        buildSetupUi();
        edgeToEdge();
        pending = getIntent();
        java.util.List<String> want = new java.util.ArrayList<>();
        if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            want.add(Manifest.permission.READ_EXTERNAL_STORAGE);
            want.add(Manifest.permission.WRITE_EXTERNAL_STORAGE);
        }
        if (want.isEmpty()) boot();
        else requestPermissions(want.toArray(new String[0]), 1);
    }

    @Override public void onRequestPermissionsResult(int code, String[] p, int[] r) {
        boot();   // 没给也照样跑：工作区退回私有目录
    }

    private void boot() {
        // 先起前台服务再干活：安装要下载几百 MB，期间用户一切走，
        // 没有前台服务的进程几秒内就会被冻结/回收（实测切一下前台下载就断了）。
        GatewayService.start(this);
        new Thread(() -> {
            try {
                Installer ins = new Installer(env, new Installer.Progress() {
                    public void step(String m) { say(m); }
                    public void bytes(long d, long t) { progress(d, t); }
                });
                // 上次换工具包被打断（APK 升级重启、进程被杀）：先收拾到一致状态，再判断装没装好。
                // 只在真有残局时才停网关：界面被系统回收后重新打开也会走到这里，那时网关可能正在跑任务，
                // 无条件停一下就把用户的任务杀了。正在替换工具包（另一个界面实例发起的）时也别插手
                Updater upd0 = Updater.get(this);
                if (!upd0.devkitMoving() && ins.needsRecovery()) {
                    GatewayService.pause(true);
                    try {
                        if (ins.recover()) {
                            say("✓ 开发工具包已恢复到一致状态");
                            Ledger.add(env, "recover", true, ins.recovered != null ? ins.recovered : "收拾了上次中断留下的目录", null);
                        }
                    } catch (Exception e) {
                        Ledger.add(env, "recover", false, "启动时恢复失败：" + e.getMessage(), null);
                        throw e;
                    } finally { GatewayService.pause(false); }
                }
                Updater.get(this).dropStagedIfInstalled();
                if (!env.devkitReady()) {
                    String src = null;
                    for (String l : LOCAL_DEVKIT) if (new File(l).canRead()) { src = l; break; }
                    if (src != null) {
                        say("开发工具包来源：" + src);
                        ins.installDevkit(src);
                    } else {
                        File gz = ins.downloadDevkit(readAsset("devkit-sources.txt").trim().split("\\s+"));
                        ins.installDevkit(gz.getPath());
                        gz.delete();      // 解完就删，腾出 600MB
                    }
                    say("✓ 开发工具包就绪");
                    Ledger.add(env, "install", true, "首次安装开发工具包", null);
                }
                deployAssets();
                if (!env.claudeReady()) {
                    ins.installClaude(new File(env.app, "scripts/install-claude.sh"));
                    say("✓ Claude Code 就绪");
                }
                // 上次自动下好的工具包更新：趁现在（刚打开、没有任务）装上
                Updater upd = Updater.get(this);
                if (upd.auto() && upd.devkitStaged()) {
                    // 先等网关答话再问它忙不忙：刚起的网关回话慢，读超时会被当成「忙」，更新就一直装不上
                    for (int i = 0; i < 40 && !Updater.pingGateway(); i++) Thread.sleep(250);
                    if (!Updater.gatewayBusy()) {
                        say("安装已下载的开发工具包更新…");
                        upd.applyDevkit(ins);
                        say("✓ 开发工具包已更新");
                    } else say("开发工具包更新已下载；有任务在跑，等空闲时再装（也可在设置页手动装）");
                }
                askBatteryExemption();
                say("等待网关…");
                for (int i = 0; i < 120 && !ping(); i++) Thread.sleep(500);
                ui.post(() -> { showWeb(); booted = true; handle(pending); pending = null; });
                // 后台快速自检：只看文件在不在，缺了就提示修复
                if (!upd.devkitMoving() && !upd.devkitStaged()) upd.verifyAsync(false);
            } catch (Exception e) {
                android.util.Log.e("cccodroid-setup", "安装失败", e);
                say("✗ " + humanize(e));
                say("（下载过的部分都留着。处理好之后点「重试」，会从这一步接着来）");
                ui.post(() -> { retry.setVisibility(View.VISIBLE); stuck.setVisibility(View.VISIBLE); });
            }
        }, "boot").start();
    }

    /** 安装失败的原因用人话说：原始异常常是一串英文，用户看不出该干什么（原文仍进 logcat） */
    static String humanize(Throwable e) {
        String raw = String.valueOf(e.getMessage());
        for (Throwable c = e; c != null; c = c.getCause()) {
            String m = String.valueOf(c.getMessage());
            if (c instanceof Installer.NoSpace) return m;
            if (m.contains("ENOSPC") || m.contains("No space left")) return "存储空间不够，写到一半满了。清理出 3 GB 左右的空间后点「重试」。";
            if (c instanceof java.net.UnknownHostException)
                return "连不上网络（找不到服务器）。检查 Wi-Fi / 移动数据是否能上网；开着 VPN 或代理的话，试试关掉或换个节点。";
            if (c instanceof java.net.SocketTimeoutException || c instanceof java.net.ConnectException || c instanceof javax.net.ssl.SSLException
                || m.contains("unexpected end of stream") || m.contains("Connection reset"))
                return "网络不稳，下载中断了（" + c.getClass().getSimpleName() + "）。换个网络或稍后点「重试」，已下载的部分会接着续传。";
            if (m.contains("sha256 不符"))
                return "下载的文件没通过校验（可能被网络或代理改了内容），坏的那份已经删掉。点「重试」会重新下载。";
            if (m.contains("HTTP 403") || m.contains("HTTP 429"))
                return "下载服务器暂时拒绝了请求（" + m + "），多半是访问太频繁。过几分钟再点「重试」。";
        }
        return raw;
    }

    @Override protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        if (booted) handle(i); else pending = i;
    }

    @Override protected void onResume() { super.onResume(); visible = true; Battery.foreground(true);
        if (pane != null) pane.resume();
        getSystemService(android.app.NotificationManager.class).cancel(41);    // Priv.toFront 的「点此回来」
        Notify.get(this).onForeground(); }                                    // 确认卡就在眼前，通知撤掉
    @Override protected void onPause() { visible = false; Battery.foreground(false); super.onPause();
        if (pane != null) pane.pause();
        Notify.get(this).onBackground(); }                                    // 还有没答的确认：现在补发通知

    // ── 外观：界面（theme.js）定浅 / 深，系统夜间模式只有原生层知道 ──
    private boolean systemNight() {
        return (android.content.res.Resources.getSystem().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
            == android.content.res.Configuration.UI_MODE_NIGHT_YES;
    }
    /** 界面里选的外观：theme.js 每次定下来都经 CCApp.themePref 存一份；没存过（第一次装）= 跟随系统 */
    private boolean uiDark() { return BrowserPane.night(this); }
    /** 状态栏 / 导航栏跟着界面换色；浅色时图标改深色 */
    private void applyBars(boolean dark) {
        android.view.Window w = getWindow();
        int bg = dark ? Color.parseColor("#1f1e1d") : Color.parseColor("#faf9f5");
        w.setNavigationBarColor(bg);           // 状态栏保持透明（见 edgeToEdge），只换图标深浅
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            int m = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                  | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            android.view.WindowInsetsController c = w.getInsetsController();
            if (c != null) c.setSystemBarsAppearance(dark ? 0 : m, m);
        } else {
            View d = w.getDecorView();
            int f = d.getSystemUiVisibility();
            int m = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            d.setSystemUiVisibility(dark ? f & ~m : f | m);
        }
    }
    @Override public void onConfigurationChanged(android.content.res.Configuration cfg) {
        super.onConfigurationChanged(cfg);
        if (web != null) web.evaluateJavascript("window.Theme&&Theme.system(" + systemNight() + ")", null);
    }

    /** 通知或设置页递过来的动作 */
    private void handle(Intent i) {
        String a = i == null ? null : i.getAction();
        if (a == null) return;
        if (ACTION_APPLY_DEVKIT.equals(a) || ACTION_UPDATE.equals(a) && "devkit".equals(i.getStringExtra("item"))) applyDevkitUi();
        else if (ACTION_UPDATE.equals(a)) Updater.get(this).apply(i.getStringExtra("item"), true);
        else if (ACTION_SHIZUKU.equals(a)) ShizukuSetup.get(this).activate();
        else if (Notify.ACTION_OPEN.equals(a)) openSession(i.getStringExtra("session"));
    }

    /** 从「已完成」通知点进来：切到那个会话（界面正显示它就不动）。页面可能还在启动，等 __cc 就绪 */
    private void openSession(String sid) {
        if (web == null || sid == null || !sid.matches("[0-9A-Za-z-]{8,64}")) return;
        web.evaluateJavascript("(function f(n){var c=window.__cc;if(c&&c.view){setTimeout(function(){if(c.view.sessionId!==\"" + sid
            + "\")c.openSession(\"" + sid + "\")},n?800:0)}else if(n<50)setTimeout(function(){f(n+1)},200)})(0)", null);
    }

    /** 替换工具包：网关要停，界面切回进度页，装完再回来 */
    private void applyDevkitUi() {
        Updater upd = Updater.get(this);
        if (!upd.devkitStaged()) { upd.apply("devkit", true); return; }     // 还没下：先下，下完会再走到这里
        new Thread(() -> {
            if (Updater.gatewayBusy()) {
                ui.post(() -> android.widget.Toast.makeText(this, "有任务正在跑，等它结束再更新开发工具包", android.widget.Toast.LENGTH_LONG).show());
                return;
            }
            CountDownLatch shown = new CountDownLatch(1);
            ui.post(() -> {
                if (web != null) { web.destroy(); web = null; }
                booted = false;
                buildSetupUi();
                shown.countDown();
            });
            try {
                shown.await();
                say("更新开发工具包…");
                upd.applyDevkit(new Installer(env, new Installer.Progress() {
                    public void step(String m) { say(m); }
                    public void bytes(long d, long t) { progress(d, t); }
                }));
                say("✓ 开发工具包已更新，等待网关…");
            } catch (Exception e) {
                say("✗ " + e.getMessage());
                say("（旧的工具包已经不在了的话，划掉应用重新打开会重新安装）");
            }
            try { for (int i = 0; i < 120 && !ping(); i++) Thread.sleep(500); } catch (InterruptedException ignored) {}
            ui.post(() -> { showWeb(); booted = true; });
        }, "devkit-apply").start();
    }

    /** assets/app → files/app。内容哈希写在 .tag 里，没变就不动 */
    private void deployAssets() throws Exception {
        String want = readAsset("app/TAG")  /* aapt2 打包时会丢掉点开头的文件 */;
        File tag = new File(env.app, "TAG");
        String have = tag.isFile() ? new String(java.nio.file.Files.readAllBytes(tag.toPath())) : "";
        if (want.equals(have)) return;
        say("部署界面与网关 " + want.trim());
        // boot() 一开头就起了网关服务，守护线程可能已经拿旧的 server.mjs 把 node 拉起来了 ——
        // 不停一下，升级后界面是新的、网关还是旧的（新接口全 404），直到下次重启。
        // 只在内容哈希变了（= 刚升级，进程本来就被安装杀过）时走到这里，不会打断任务
        GatewayService.pause(true);
        try {
            Installer.deleteTree(env.app);
            copyAssetDir("app", env.app);
            // lib/ 里除了 .so 还有可执行的 seccomp-enosys-run、ptyhost
            for (String d : new String[]{"scripts", "bin", "lib"}) {
                File[] fs = new File(env.app, d).listFiles();
                if (fs != null) for (File f : fs) f.setExecutable(true, true);
            }
        } finally {
            // 守护线程若恰好在 pause 前一刻已经在拉 node，这里再杀一次，保证起来的一定是新文件
            GatewayService.pause(true);
            GatewayService.pause(false);
        }
    }

    private void copyAssetDir(String path, File dst) throws Exception {
        String[] kids = getAssets().list(path);
        if (kids == null || kids.length == 0) {
            dst.getParentFile().mkdirs();
            try (InputStream in = getAssets().open(path); OutputStream o = new FileOutputStream(dst)) {
                byte[] buf = new byte[1 << 16];
                for (int n; (n = in.read(buf)) > 0; ) o.write(buf, 0, n);
            }
            return;
        }
        dst.mkdirs();
        for (String k : kids) copyAssetDir(path + "/" + k, new File(dst, k));
    }

    private String readAsset(String p) throws Exception {
        try (InputStream in = getAssets().open(p)) {
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            for (int n; (n = in.read(buf)) > 0; ) bo.write(buf, 0, n);
            return bo.toString("UTF-8");
        }
    }

    /** 电池优化会在锁屏后冻结我们 —— 只问一次，用户拒绝就不再打扰 */
    @SuppressLint("BatteryLife")
    private void askBatteryExemption() {
        PowerManager pm = getSystemService(PowerManager.class);
        SharedPreferences sp = getSharedPreferences("ui", MODE_PRIVATE);
        if (pm.isIgnoringBatteryOptimizations(getPackageName()) || sp.getBoolean("askedBattery", false)) return;
        sp.edit().putBoolean("askedBattery", true).apply();
        ui.post(() -> {
            try {
                startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
            } catch (Exception ignored) {}
        });
    }

    /**
     * 通知被关时引导去设置页开。targetSdk 28 的应用不能自己弹通知权限框（requestPermissions 会被系统直接忽略），
     * 本该由系统在"界面在前台时建第一个通知渠道"那一刻代问 —— 但我们的渠道由前台服务建，常常错过时机，
     * 之后系统就再也不问，通知被整个屏蔽（实测 Android 14：发了 15 条、显示 0 条）。只问一次。
     */
    private void askNotifications() {
        android.app.NotificationManager nm = getSystemService(android.app.NotificationManager.class);
        SharedPreferences sp = getSharedPreferences("ui", MODE_PRIVATE);
        if (nm.areNotificationsEnabled() || sp.getBoolean("askedNotifySettings", false)) return;
        sp.edit().putBoolean("askedNotifySettings", true).apply();
        new android.app.AlertDialog.Builder(this)
            .setTitle("开启通知")
            .setMessage("cccodroid 在后台跑任务时靠一条常驻通知保活；任务完成或需要你确认时也通过通知提醒。\n\n系统目前屏蔽了本应用的通知，去设置里打开吧。")
            .setPositiveButton("去开启", (d, w) -> {
                try {
                    startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
                } catch (Exception e) {
                    startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
                }
            })
            .setNegativeButton("以后再说", null)
            .show();
    }

    private boolean ping() {
        try {
            HttpURLConnection c = Env.gateway("/api/status");
            c.setConnectTimeout(800); c.setReadTimeout(1500);
            return c.getResponseCode() == 200;
        } catch (Exception e) { return false; }
    }

    // ── 系统栏：铺满窗口，顶部占位交给页面自己避让 ─────────────────────
    //  以前由系统在顶上留一条状态栏高度的底色：分屏时下半屏没有状态栏，却也留着一条灰条。
    //  现在窗口画到状态栏底下，系统报多少顶部占位（WindowInsets）就告诉页面多少（--safe-t），
    //  顶栏的底色自己延伸上去；分屏没有状态栏时报 0，界面就占满。底部 / 左右 / 输入法仍由这里留白（adjustResize 不变）。
    private int insetTop = 0;
    private void edgeToEdge() {
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        View d = getWindow().getDecorView();
        d.setSystemUiVisibility(d.getSystemUiVisibility()
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        root.setOnApplyWindowInsetsListener((v, in) -> {
            insetTop = in.getSystemWindowInsetTop();
            // 安装页没有网页来避让，顶部也由这里留白；界面起来以后交给 --safe-t
            v.setPadding(in.getSystemWindowInsetLeft(), web == null ? insetTop : 0, in.getSystemWindowInsetRight(), in.getSystemWindowInsetBottom());
            pushInsets();
            return in.consumeSystemWindowInsets();
        });
    }
    private void pushInsets() {
        if (web == null) return;
        float css = insetTop / getResources().getDisplayMetrics().density;
        web.evaluateJavascript("document.documentElement.style.setProperty('--safe-t','" + css + "px')", null);
    }

    // ── 界面 ───────────────────────────────────────────────────────────
    private void buildSetupUi() {
        boolean dark = uiDark();
        int accent = Color.parseColor(dark ? "#d97757" : "#c96442");
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor(dark ? "#1f1e1d" : "#faf9f5"));
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(dp(20), dp(40), dp(20), dp(20));
        TextView title = new TextView(this);
        title.setText("cccodroid");
        title.setTextSize(26);
        title.setTypeface(android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL));
        title.setPadding(0, 0, 0, dp(10));
        title.setTextColor(accent);
        col.addView(title);
        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setIndeterminate(true);
        bar.setProgressTintList(android.content.res.ColorStateList.valueOf(accent));
        bar.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(accent));
        bar.setProgressBackgroundTintList(android.content.res.ColorStateList.valueOf(Color.parseColor(dark ? "#3a3935" : "#e0dcd0")));
        col.addView(bar, new LinearLayout.LayoutParams(-1, dp(8)));
        stat = new TextView(this);
        stat.setTextColor(Color.parseColor(dark ? "#ece9e1" : "#29261f"));
        stat.setTextSize(12.5f);
        stat.setPadding(0, dp(6), 0, dp(10));
        stat.setTypeface(android.graphics.Typeface.MONOSPACE);
        col.addView(stat);
        log = new TextView(this);
        log.setTextColor(Color.parseColor(dark ? "#aaa59b" : "#5d594f"));   // 原始输出压暗一档，进度和结论靠上面那行
        log.setTextSize(11.5f);
        log.setLineSpacing(0, 1.15f);
        log.setTypeface(android.graphics.Typeface.MONOSPACE);
        logScroll = new ScrollView(this);
        logScroll.addView(log);
        col.addView(logScroll, new LinearLayout.LayoutParams(-1, 0, 1));
        retry = new android.widget.Button(this);
        retry.setText("重试");
        retry.setVisibility(View.GONE);
        retry.setOnClickListener(v -> { retry.setVisibility(View.GONE); stuck.setVisibility(View.GONE); say("— 重试 —"); boot(); });
        // 「我卡住了」：界面还没起来时（安装就失败了）也能把诊断包发出去
        stuck = new android.widget.Button(this);
        stuck.setText("我卡住了：分享诊断");
        stuck.setVisibility(View.GONE);
        stuck.setOnClickListener(v -> new android.app.AlertDialog.Builder(this)
            .setTitle("打包诊断信息")
            .setMessage(Share.CONTENTS)
            .setPositiveButton("打包并分享", (d, w) -> new Thread(() -> {
                try { Share.send(this, Share.bundleLogs(this), "application/zip"); }
                catch (Exception e) { say("✗ 诊断包没打成：" + e.getMessage()); }
            }, "stuck").start())
            .setNegativeButton("取消", null).show());
        LinearLayout acts = new LinearLayout(this);
        acts.addView(retry, new LinearLayout.LayoutParams(-2, -2));
        acts.addView(stuck, new LinearLayout.LayoutParams(-2, -2));
        col.addView(acts, new LinearLayout.LayoutParams(-1, -2));
        root.addView(col);
        setContentView(root);
        applyBars(dark);
    }

    private void say(String m) {
        android.util.Log.i("cccodroid-setup", m);      // 安装 / 更新出问题时，logcat 里能看到走到了哪一步
        ui.post(() -> {
            log.append(m + "\n");
            if (log.getLineCount() > 400) log.setText(log.getText().subSequence(log.getText().length() / 2, log.getText().length()));
            logScroll.post(() -> logScroll.fullScroll(View.FOCUS_DOWN));
        });
    }

    // 下载 / 解包进度：已完成 / 总量 · 百分比 · 速度 · 剩余时间。几百 MB 走十分钟，光一根条看不出是不是卡住了
    private long lastD = -1, lastT;
    private double speed;                     // 字节/秒，指数平滑
    private void progress(long d, long t) {
        long now = System.currentTimeMillis();
        if (d < lastD || lastD < 0) { speed = 0; lastD = d; lastT = now; }      // 新的一段（换了阶段）
        else if (now - lastT >= 1000) {
            double v = (d - lastD) * 1000.0 / (now - lastT);
            speed = speed == 0 ? v : speed * 0.7 + v * 0.3;
            lastD = d; lastT = now;
        }
        String txt;
        if (t <= 0) txt = mb(d);
        else {
            txt = mb(d) + " / " + mb(t) + " · " + (d * 100 / t) + "%";
            if (speed > 0 && d < t) {
                long eta = (long) ((t - d) / speed);
                txt += " · " + mb((long) speed) + "/s · 剩约 " + (eta >= 60 ? (eta / 60) + " 分" : eta + " 秒");
            }
        }
        final String line = txt;
        ui.post(() -> {
            if (t <= 0) bar.setIndeterminate(true);
            else { bar.setIndeterminate(false); bar.setProgress((int) (d * 100 / t)); }
            stat.setText(line);
        });
    }
    private static String mb(long b) { return String.format(java.util.Locale.ROOT, b >= 100 << 20 ? "%.0f MB" : "%.1f MB", b / 1048576.0); }

    @SuppressLint("SetJavaScriptEnabled")
    private void showWeb() {
        askNotifications();
        // 网页调试默认关：开着时任何连上 adb 的电脑都能读页面（含网关令牌）。
        // 要调试就在终端里 touch ~/.webdebug，重开应用生效；只有本机终端写得进私有目录
        WebView.setWebContentsDebuggingEnabled(new File(env.home, ".webdebug").exists());
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.setBackgroundColor(Color.parseColor(uiDark() ? "#1f1e1d" : "#faf9f5"));
        // 本机网关之外的地址一律交给系统浏览器：登录授权页、"去官网创建 Key" 之类。
        // 在 WebView 里打开登录页会被 Google 等拒绝，而且 OAuth 回调要回到浏览器才能跳 localhost。
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, String url) {
                if (url != null && url.startsWith("http://127.0.0.1:" + Env.PORT)) return false;
                openExternal(url);
                return true;
            }
            @Override public void onPageFinished(WebView v, String url) {
                if (bounceStage != 0) {   // 冻结脱困中：跳出去那一下落地了就马上跳回来；回到网关页面才算完
                    if (url == null || !url.startsWith("http://127.0.0.1:")) { if (bounceStage == 1) bounceBack(); return; }
                    bounceStage = 0; web.setVisibility(View.VISIBLE);
                }
                pushInsets();
            }
        });
        web.addJavascriptInterface(new Object() {
            @android.webkit.JavascriptInterface public void openUrl(String url) {
                if (url != null && (url.startsWith("https://") || url.startsWith("http://"))) ui.post(() -> openExternal(url));
            }
            // ── 嵌入式浏览器窗格（宽屏）：页面决定开不开、摆在哪；关掉（✕）回调 __ccBrowserClosed ──
            @android.webkit.JavascriptInterface public boolean hasPane() { return true; }
            @android.webkit.JavascriptInterface public void paneOpen(String url) {
                if (url != null && !url.isEmpty() && !url.startsWith("https://") && !url.startsWith("http://")) return;
                ui.post(() -> openPane(url));
            }
            /** 页面坐标（CSS px，相对对话 WebView 左上角）；w <= 0 = 先藏起来（被别的窗格 / 浮层盖住时） */
            @android.webkit.JavascriptInterface public void paneBounds(float x, float y, float w, float h) {
                ui.post(() -> placePane(x, y, w, h));
            }
            @android.webkit.JavascriptInterface public boolean paneCanBack() { return paneCanBack; }
            @android.webkit.JavascriptInterface public void paneGoBack() { ui.post(() -> { if (pane != null) pane.back(); }); }
            @android.webkit.JavascriptInterface public void paneClose() { ui.post(() -> closePane(false)); }
            /** 应用内浏览器（回复里的网页链接、本机开发服务）；url 为空 = 回到上次那页 */
            @android.webkit.JavascriptInterface public void openBrowser(String url) {
                if (url == null || url.isEmpty() || url.startsWith("https://") || url.startsWith("http://"))
                    ui.post(() -> BrowserActivity.open(MainActivity.this, url));
            }
            /** 回复底下的「转发」：把正文交给系统分享面板 */
            @android.webkit.JavascriptInterface public void shareText(String text) {
                if (text != null && !text.isEmpty()) ui.post(() -> shareTextNow(text));
            }
            /** 冻结脱困：WebView 偶发把这个文档的触摸滚动整个吞掉，同站重载不好，跨站跳一次再回来才好。见 bounce() */
            @android.webkit.JavascriptInterface public void unfreeze() { ui.post(() -> bounce()); }
            @android.webkit.JavascriptInterface public boolean nightMode() { return systemNight(); }
            @android.webkit.JavascriptInterface public void setBars(boolean dark) { ui.post(() -> applyBars(dark)); }
            /** 界面里的外观设置（auto / light / dark），下次启动时安装页照着上色 */
            @android.webkit.JavascriptInterface public void themePref(String p) {
                if ("auto".equals(p) || "light".equals(p) || "dark".equals(p))
                    getSharedPreferences("ui", MODE_PRIVATE).edit().putString("theme", p).apply();
                // 之后新开的系统控件（下拉框的选项窗、对话框）也跟着换深浅，不用重开应用
                ui.post(() -> setTheme(uiDark() ? android.R.style.Theme_Material_NoActionBar : android.R.style.Theme_Material_Light_NoActionBar));
            }
            /** 「保存到」：弹系统文件面板（ACTION_CREATE_DOCUMENT），用户挑好位置后把文件复制过去。
             *  不需要存储权限，也不会落进用户打不开的私有目录。结果回调页面的 __ccSaved(ok, 说明) */
            @android.webkit.JavascriptInterface public void saveAs(String path, String name, String mime) {
                ui.post(() -> startSaveAs(path, name, mime));
            }
        }, "CCApp");
        // 兜底：没走 saveAs 的下载链接（<a download> 指向本机网关的 /api/file）也改成「保存到」
        web.setDownloadListener((url, ua, cd, mime, len) -> {
            Uri u = Uri.parse(url);
            String p = u.getQueryParameter("path");
            if (p != null && url.startsWith("http://127.0.0.1:" + Env.PORT + "/api/file")) startSaveAs(p, new File(p).getName(), mime);
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                try { startActivityForResult(p.createIntent(), 7); } catch (Exception e) { fileCb = null; return false; }
                return true;
            }
            // 页面里的 alert / confirm / prompt：系统默认的对话框标题是「网址为 http://127.0.0.1 的网页显示」，
            // 换成不带标题、跟着界面外观的对话框；按钮文字用系统自带的（随系统语言）
            @Override public boolean onJsAlert(WebView v, String url, String msg, android.webkit.JsResult r) {
                jsDialog(msg, false, null, r, null); return true;
            }
            @Override public boolean onJsConfirm(WebView v, String url, String msg, android.webkit.JsResult r) {
                jsDialog(msg, true, null, r, null); return true;
            }
            @Override public boolean onJsPrompt(WebView v, String url, String msg, String def, android.webkit.JsPromptResult r) {
                jsDialog(msg, true, def == null ? "" : def, r, r); return true;
            }
        });
        web.loadUrl(Env.uiUrl());
        root.removeAllViews();
        root.addView(web);
        root.requestApplyInsets();            // 顶部留白交给页面（--safe-t）
    }

    // ── 冻结脱困 ─────────────────────────────────────────────────────
    //  2026-10-16 实测：触摸滚动冻住后 location.reload() 和切后台都不好，跳到 127.0.0.2:9 再跳回来就好 ——
    //  卡住的是 WebView 给这个文档的手势状态，换站点才会重建。127.0.0.2:9 是浏览器直接拒绝的端口，不发任何网络请求。
    //  loadUrl 不经过 shouldOverrideUrlLoading，不会被当外链拦掉。跳的那一下先把 WebView 藏起来，免得闪错误页。
    private int bounceStage = 0;   // 0 没在脱困 · 1 正跳出去 · 2 正跳回来
    private void bounce() {
        if (web == null || bounceStage != 0) return;
        bounceStage = 1;
        web.setVisibility(View.INVISIBLE);
        web.loadUrl("http://127.0.0.2:9/");
        ui.postDelayed(() -> { if (bounceStage == 1) bounceBack(); }, 1500);   // 落地回调没来
        ui.postDelayed(() -> { if (bounceStage != 0) { bounceStage = 0; web.setVisibility(View.VISIBLE); } }, 10000);
    }
    private void bounceBack() {
        bounceStage = 2;
        web.loadUrl(Env.uiUrl());
    }

    private void jsDialog(String msg, boolean withCancel, String def, android.webkit.JsResult r, android.webkit.JsPromptResult pr) {
        final android.widget.EditText in = def == null ? null : new android.widget.EditText(this);
        if (in != null) in.setText(def);
        boolean dark = uiDark();
        android.app.AlertDialog.Builder b = new android.app.AlertDialog.Builder(this,
                dark ? android.R.style.Theme_Material_Dialog_Alert : android.R.style.Theme_Material_Light_Dialog_Alert)
            .setMessage(msg).setCancelable(true)
            .setOnCancelListener(d -> r.cancel());
        if (in != null) b.setView(in);
        b.setPositiveButton(android.R.string.ok, (d, w) -> { if (pr != null) pr.confirm(in.getText().toString()); else r.confirm(); });
        if (withCancel) b.setNegativeButton(android.R.string.cancel, (d, w) -> r.cancel());
        try {
            android.app.AlertDialog d = b.show();
            int accent = Color.parseColor(dark ? "#d97757" : "#c96442");
            d.getWindow().setBackgroundDrawable(roundBg(Color.parseColor(dark ? "#262624" : "#faf9f5")));
            for (int k : new int[] { android.app.AlertDialog.BUTTON_POSITIVE, android.app.AlertDialog.BUTTON_NEGATIVE }) {
                android.widget.Button bt = d.getButton(k);
                if (bt != null) bt.setTextColor(accent);
            }
        } catch (Exception e) { r.cancel(); }
    }
    private android.graphics.drawable.Drawable roundBg(int color) {
        android.graphics.drawable.GradientDrawable g = new android.graphics.drawable.GradientDrawable();
        g.setColor(color);
        g.setCornerRadius(dp(16));
        return new android.graphics.drawable.InsetDrawable(g, dp(16));
    }

    private void openExternal(String url) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
        catch (Exception e) { android.widget.Toast.makeText(this, "没有可用的浏览器：" + url, android.widget.Toast.LENGTH_LONG).show(); }
    }

    private void startSaveAs(String path, String name, String mime) {
        File f = path == null ? null : new File(path);
        if (f == null || !f.isFile()) { savedJs(false, "missing"); return; }
        savePending = f;
        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime)
            .putExtra(Intent.EXTRA_TITLE, name == null || name.isEmpty() ? f.getName() : name);
        try { startActivityForResult(i, 8); }
        catch (Exception e) { savePending = null; savedJs(false, "nopicker"); }
    }

    /** 复制放后台线程：大文件（几百 MB 的导出包）别卡住界面 */
    private void finishSaveAs(Uri dst) {
        File src = savePending;
        savePending = null;
        if (src == null) return;
        new Thread(() -> {
            boolean ok = false;
            String msg;
            try (InputStream in = new java.io.FileInputStream(src); OutputStream out = getContentResolver().openOutputStream(dst, "w")) {
                if (out == null) throw new java.io.IOException("openOutputStream 返回 null");
                byte[] buf = new byte[1 << 16];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                ok = true;
                msg = src.getName();
            } catch (Exception e) {
                msg = String.valueOf(e.getMessage());
                try { android.provider.DocumentsContract.deleteDocument(getContentResolver(), dst); } catch (Exception ignore) {}
            }
            final boolean fok = ok; final String fmsg = msg;
            ui.post(() -> savedJs(fok, fmsg));
        }, "save-as").start();
    }

    private void savedJs(boolean ok, String msg) {
        if (web != null) web.evaluateJavascript("window.__ccSaved&&__ccSaved(" + ok + "," + org.json.JSONObject.quote(msg) + ")", null);
    }

    // ── 嵌入式浏览器窗格 ──
    private void openPane(String url) {
        if (web == null) return;
        if (pane == null) {
            pane = new BrowserPane(this, new BrowserPane.Host() {
                @Override public void onPaneClose() { closePane(true); }
            }, 9);
            pane.setVisibility(View.GONE);               // 等页面报来位置再显示，免得先闪一下全屏
            root.addView(pane, new FrameLayout.LayoutParams(0, 0));
            pane.load(url);
            tickPaneBack();
        } else if (url != null && !url.isEmpty()) pane.load(url);
    }
    private void placePane(float x, float y, float w, float h) {
        if (pane == null) return;
        if (w <= 0 || h <= 0) { pane.setVisibility(View.GONE); return; }
        float d = getResources().getDisplayMetrics().density;
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) pane.getLayoutParams();
        lp.leftMargin = Math.round(x * d); lp.topMargin = Math.round(y * d);
        lp.width = Math.round(w * d); lp.height = Math.round(h * d);
        pane.setLayoutParams(lp);
        pane.setVisibility(View.VISIBLE);
    }
    /** 系统分享面板。正文太长会撑爆 Binder 事务（约 1 MB），截到 100k 字符 */
    private void shareTextNow(String text) {
        if (text.length() > 100000) text = text.substring(0, 100000);
        Intent i = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text);
        try { startActivity(Intent.createChooser(i, null)); }
        catch (Exception e) { android.util.Log.w("cccodroid", "分享失败", e); }
    }
    /** fromPane = 用户点了窗格自己的 ✕（或渲染进程崩了）：要告诉页面把占位撤掉 */
    private void closePane(boolean fromPane) {
        if (pane == null) return;
        root.removeView(pane);
        pane.destroy();
        pane = null;
        paneCanBack = false;
        if (fromPane && web != null) web.evaluateJavascript("window.__ccBrowserClosed&&__ccBrowserClosed()", null);
    }
    /** 返回手势要同步问"网页能不能后退"，JS 桥在别的线程上，这里定时把答案备好 */
    private void tickPaneBack() {
        if (pane == null) return;
        paneCanBack = pane.canBack();
        final BrowserPane p = pane;
        ui.postDelayed(() -> { if (pane == p) tickPaneBack(); }, 500);
    }

    @Override protected void onActivityResult(int req, int res, Intent data) {
        if (req == 9) { if (pane != null) pane.onResult(res, data); return; }
        if (req == 8) {
            if (res == RESULT_OK && data != null && data.getData() != null) finishSaveAs(data.getData());
            else { savePending = null; savedJs(false, "cancel"); }
            return;
        }
        if (req == 7 && fileCb != null) {
            fileCb.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data));
            fileCb = null;
        }
    }

    @Override public void onBackPressed() {
        if (web == null) { moveTaskToBack(true); return; }
        // 先让页面关最上层的浮层（侧栏 / 查看器 / 终端 / 弹窗…，见 app.js __ccBack），都没开才退
        web.evaluateJavascript("window.__ccBack?__ccBack():false", v -> {
            if ("true".equals(v)) return;
            if (web != null && web.canGoBack()) web.goBack();
            else moveTaskToBack(true);   // 返回键不结束界面，网关本来也不靠界面活着
        });
    }

    private int dp(int v) { return Math.round(getResources().getDisplayMetrics().density * v); }
}
