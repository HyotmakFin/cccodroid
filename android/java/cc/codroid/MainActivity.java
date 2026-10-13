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

/**
 * 启动流程：存储权限 → 开发工具包 → 官方 Claude Code → 网关代码 → 前台服务 → 界面。
 * 每一步都能重入：装到一半被杀，下次打开从缺的那一步接着来。
 */
public class MainActivity extends Activity {
    /** 本地工具包（离线安装 / 开发期）：放在共享目录就优先用它；下载地址见 assets/devkit-sources.txt */
    static final String[] LOCAL_DEVKIT = {
        "/sdcard/cccodroid/devkit-cc.codroid.tar.gz", "/sdcard/cccodroid/devkit-cc.codroid.tar",
    };

    private Env env;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private TextView log;
    private ScrollView logScroll;
    private ProgressBar bar;
    private TextView stat;
    private WebView web;
    private ValueCallback<Uri[]> fileCb;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        env = new Env(this);
        getWindow().setStatusBarColor(Color.parseColor("#0d1117"));
        buildSetupUi();
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
                }
                deployAssets();
                if (!env.claudeReady()) {
                    ins.installClaude(new File(env.app, "scripts/install-claude.sh"));
                    say("✓ Claude Code 就绪");
                }
                askBatteryExemption();
                say("等待网关…");
                for (int i = 0; i < 120 && !ping(); i++) Thread.sleep(500);
                ui.post(this::showWeb);
            } catch (Exception e) {
                say("✗ " + e.getMessage());
                say("（修好网络或文件后，划掉应用重新打开即可从这一步继续）");
            }
        }, "boot").start();
    }

    /** assets/app → files/app。内容哈希写在 .tag 里，没变就不动 */
    private void deployAssets() throws Exception {
        String want = readAsset("app/TAG")  /* aapt2 打包时会丢掉点开头的文件 */;
        File tag = new File(env.app, "TAG");
        String have = tag.isFile() ? new String(java.nio.file.Files.readAllBytes(tag.toPath())) : "";
        if (want.equals(have)) return;
        say("部署界面与网关 " + want.trim());
        Installer.deleteTree(env.app);
        copyAssetDir("app", env.app);
        for (String d : new String[]{"scripts", "bin"}) {
            File[] fs = new File(env.app, d).listFiles();
            if (fs != null) for (File f : fs) f.setExecutable(true, true);
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
            HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + Env.PORT + "/api/status").openConnection();
            c.setConnectTimeout(800); c.setReadTimeout(1500);
            return c.getResponseCode() == 200;
        } catch (Exception e) { return false; }
    }

    // ── 界面 ───────────────────────────────────────────────────────────
    private void buildSetupUi() {
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0d1117"));
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(dp(20), dp(40), dp(20), dp(20));
        TextView title = new TextView(this);
        title.setText("cccodroid");
        title.setTextSize(24);
        title.setTextColor(Color.parseColor("#f0883e"));
        col.addView(title);
        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setIndeterminate(true);
        col.addView(bar, new LinearLayout.LayoutParams(-1, dp(12)));
        stat = new TextView(this);
        stat.setTextColor(Color.parseColor("#8b949e"));
        stat.setTextSize(12);
        stat.setTypeface(android.graphics.Typeface.MONOSPACE);
        col.addView(stat);
        log = new TextView(this);
        log.setTextColor(Color.parseColor("#c9d1d9"));
        log.setTextSize(12);
        log.setTypeface(android.graphics.Typeface.MONOSPACE);
        logScroll = new ScrollView(this);
        logScroll.addView(log);
        col.addView(logScroll, new LinearLayout.LayoutParams(-1, 0, 1));
        root.addView(col);
        setContentView(root);
    }

    private void say(String m) {
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
        WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.setBackgroundColor(Color.parseColor("#0d1117"));
        // 本机网关之外的地址一律交给系统浏览器：登录授权页、"去官网创建 Key" 之类。
        // 在 WebView 里打开登录页会被 Google 等拒绝，而且 OAuth 回调要回到浏览器才能跳 localhost。
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, String url) {
                if (url != null && url.startsWith("http://127.0.0.1:" + Env.PORT)) return false;
                openExternal(url);
                return true;
            }
        });
        web.addJavascriptInterface(new Object() {
            @android.webkit.JavascriptInterface public void openUrl(String url) {
                if (url != null && (url.startsWith("https://") || url.startsWith("http://"))) ui.post(() -> openExternal(url));
            }
        }, "CCApp");
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                try { startActivityForResult(p.createIntent(), 7); } catch (Exception e) { fileCb = null; return false; }
                return true;
            }
        });
        web.loadUrl("http://127.0.0.1:" + Env.PORT + "/");
        root.removeAllViews();
        root.addView(web);
    }

    private void openExternal(String url) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
        catch (Exception e) { android.widget.Toast.makeText(this, "没有可用的浏览器：" + url, android.widget.Toast.LENGTH_LONG).show(); }
    }

    @Override protected void onActivityResult(int req, int res, Intent data) {
        if (req == 7 && fileCb != null) {
            fileCb.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data));
            fileCb = null;
        }
    }

    @Override public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else moveTaskToBack(true);   // 返回键不结束界面，网关本来也不靠界面活着
    }

    private int dp(int v) { return Math.round(getResources().getDisplayMetrics().density * v); }
}
