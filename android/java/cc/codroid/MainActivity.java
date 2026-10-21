package cc.codroid;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
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
    /** 本地工具包（离线安装 / 开发期）：放在共享目录的话，首装的来源选择里多一项直接用它（照样核对来源） */
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
    /** 首装时「工具包从哪装」的选择面板（安装页上，平时藏着） */
    private LinearLayout chooser;
    static final int REQ_DEVKIT = 10;
    /** 首装选本地文件时，boot 线程在这等系统文件选择器回来；null = 是更新卡片发起的 */
    private volatile CountDownLatch pickWait;
    private volatile Uri picked;

    @Override protected void onCreate(Bundle b) {
        Tr.init(this);
        // 安装页、空白 WebView 都按界面里选的外观（浅 / 深 / 跟随系统）上色，别再"界面浅色、启动页深色"
        setTheme(uiDark() ? android.R.style.Theme_Material_NoActionBar : android.R.style.Theme_Material_Light_NoActionBar);
        super.onCreate(b);
        // 启动画面结束就直接拿掉，不做淡出：淡出那半秒它压在安装页上，深浅不一致时就是一块颜色不对的区域
        if (Build.VERSION.SDK_INT >= 31) getSplashScreen().setOnExitAnimationListener(v -> v.remove());
        syncSplash();
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

    /**
     * 装在分身 / 第二空间 / 安全文件夹 / 工作资料里：私有目录是 /data/user/<N>/cc.codroid，
     * 比等长改写的 21 字节长，工具链里写死的 /data/data/cc.codroid 又指向主用户、跨用户被拒，跑不起来。
     * files/.force-secondary-user 存在时也当成这种情况（调试界面用）。
     */
    static boolean secondaryUser(Context c) {
        String fp = c.getFilesDir().getAbsolutePath();
        return android.os.Process.myUid() / 100000 != 0
            || !(fp.startsWith("/data/user/0/") || fp.startsWith("/data/data/"))
            || new File(c.getFilesDir(), ".force-secondary-user").exists();
    }

    private void boot() {
        if (secondaryUser(this)) {
            say(Tr.t("✗ cccodroid 只能装在手机的主空间里。"));
            say(Tr.t("分身、第二空间、安全文件夹、工作资料里的应用目录路径不同，开发工具包跑不起来（Termux 也有同样的限制）。请卸载这里的 cccodroid，在主空间安装。"));
            ui.post(() -> stuck.setVisibility(View.VISIBLE));
            return;
        }
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
                            say(Tr.t("✓ 开发工具包已恢复到一致状态"));
                            Ledger.add(env, "recover", true, ins.recovered != null ? ins.recovered : Tr.t("收拾了上次中断留下的目录"), null);
                        }
                    } catch (Exception e) {
                        Ledger.add(env, "recover", false, Tr.t("启动时恢复失败：") + e.getMessage(), null);
                        throw e;
                    } finally { GatewayService.pause(false); }
                }
                Updater.get(this).dropStagedIfInstalled();
                if (!env.devkitReady()) {
                    installFirstDevkit(ins);
                    say(Tr.t("✓ 开发工具包就绪"));
                    Ledger.add(env, "install", true, Tr.t("首次安装开发工具包"), null);
                }
                deployAssets();
                if (!env.claudeReady()) {
                    ins.installClaude(new File(env.app, "scripts/install-claude.sh"));
                    say(Tr.t("✓ Claude Code 就绪"));
                }
                // 上次自动下好的工具包更新：趁现在（刚打开、没有任务）装上
                Updater upd = Updater.get(this);
                if (upd.auto() && upd.devkitStaged()) {
                    // 先等网关答话再问它忙不忙：刚起的网关回话慢，读超时会被当成「忙」，更新就一直装不上
                    for (int i = 0; i < 40 && !Updater.pingGateway(); i++) Thread.sleep(250);
                    if (!Updater.gatewayBusy()) {
                        say(Tr.t("安装已下载的开发工具包更新…"));
                        upd.applyDevkit(ins);
                        say(Tr.t("✓ 开发工具包已更新"));
                    } else say(Tr.t("开发工具包更新已下载；有任务在跑，等空闲时再装（也可在设置页手动装）"));
                }
                askBatteryExemption();
                say(Tr.t("等待网关…"));
                for (int i = 0; i < 120 && !ping(); i++) Thread.sleep(500);
                ui.post(() -> { showWeb(); booted = true; handle(pending); pending = null; });
                // 后台快速自检：只看文件在不在，缺了就提示修复
                if (!upd.devkitMoving() && !upd.devkitStaged()) upd.verifyAsync(false);
            } catch (Exception e) {
                android.util.Log.e("cccodroid-setup", "安装失败", e);
                say("✗ " + humanize(e));
                say(Tr.t("（下载过的部分都留着。处理好之后点「重试」，会从这一步接着来）"));
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
            if (m.contains("ENOSPC") || m.contains("No space left")) return Tr.t("存储空间不够，写到一半满了。清理出 3 GB 左右的空间后点「重试」。");
            if (c instanceof java.net.UnknownHostException)
                return Tr.t("连不上网络（找不到服务器）。检查 Wi-Fi / 移动数据是否能上网；开着 VPN 或代理的话，试试关掉或换个节点。");
            if (c instanceof java.net.SocketTimeoutException || c instanceof java.net.ConnectException || c instanceof javax.net.ssl.SSLException
                || m.contains("unexpected end of stream") || m.contains("Connection reset"))
                return Tr.f("网络不稳，下载中断了（{0}）。换个网络或稍后点「重试」，已下载的部分会接着续传。", c.getClass().getSimpleName());
            if (m.contains("sha256"))
                return Tr.t("下载的文件没通过校验（可能被网络或代理改了内容），坏的那份已经删掉。点「重试」会重新下载。");
            if (m.contains("HTTP 403") || m.contains("HTTP 429"))
                return Tr.f("下载服务器暂时拒绝了请求（{0}），多半是访问太频繁。过几分钟再点「重试」。", m);
        }
        return raw;
    }

    @Override protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        if (booted) handle(i); else pending = i;
    }

    @Override public void onWindowFocusChanged(boolean has) {
        super.onWindowFocusChanged(has);
        // 只在窗口里谁都没焦点时补：应用内浏览器的地址栏 / 网页正拿着焦点时别抢
        if (has && web != null && web.getParent() != null && getCurrentFocus() == null) web.requestFocus();
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
    /** 安卓 13+：下一次启动的启动画面按界面里选的外观上色（选「跟随系统」就交还系统）。系统记住这个选择，进程没起来时也生效 */
    private void syncSplash() {
        if (Build.VERSION.SDK_INT < 33) return;
        String p = getSharedPreferences("ui", MODE_PRIVATE).getString("theme", "auto");
        int id = "auto".equals(p) ? 0 : getResources().getIdentifier("dark".equals(p) ? "LaunchDark" : "LaunchLight", "style", getPackageName());
        try { getSplashScreen().setSplashScreenTheme(id); } catch (Exception ignored) {}
    }
    /** 状态栏 / 导航栏跟着界面换色；浅色时图标改深色 */
    private void applyBars(boolean dark) {
        android.view.Window w = getWindow();
        int bg = BrowserPane.pal(this, dark, "bg");
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
        else if (Intent.ACTION_SEND.equals(a) || Intent.ACTION_SEND_MULTIPLE.equals(a)) receiveShare(i);
    }

    // ── 分享进来的东西：文件拷进工作区的 uploads/（和网页上传同一处、同样的命名），文字插进输入框 ──
    private void receiveShare(Intent i) {
        java.util.ArrayList<android.net.Uri> uris = new java.util.ArrayList<>();
        if (Intent.ACTION_SEND_MULTIPLE.equals(i.getAction())) {
            java.util.ArrayList<android.net.Uri> l = i.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (l != null) uris.addAll(l);
        } else {
            android.net.Uri u = i.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        }
        String text = i.getStringExtra(Intent.EXTRA_TEXT);
        i.setAction(null);                                  // 同一个意图只收一次（转屏重建时别再收）
        if (uris.isEmpty() && (text == null || text.isEmpty())) return;
        new Thread(() -> {
            java.io.File dir = new java.io.File(env.workspace(), "uploads");
            dir.mkdirs();
            int n = 0;
            for (android.net.Uri u : uris) {
                String name = displayName(u).replaceAll("[^\\w.\\-()\\u4e00-\\u9fff]+", "_").replaceAll("^[.\\s]+", "");
                if (name.length() > 120) name = name.substring(name.length() - 120);
                String stamp = new java.text.SimpleDateFormat("yyyyMMddHHmmss", java.util.Locale.US).format(new java.util.Date());
                java.io.File out = new java.io.File(dir, stamp + "-" + (name.isEmpty() ? "shared.bin" : name));
                for (int k = 2; out.exists(); k++) out = new java.io.File(dir, stamp + "-" + k + "-" + name);
                try (InputStream in = getContentResolver().openInputStream(u); OutputStream o = new FileOutputStream(out)) {
                    byte[] buf = new byte[1 << 16];
                    for (int r; (r = in.read(buf)) > 0; ) o.write(buf, 0, r);
                    n++;
                    toPage("ccapp-attach", out.getPath());
                } catch (Exception e) {
                    out.delete();
                    ui.post(() -> android.widget.Toast.makeText(this, Tr.f("分享的文件没收下：{0}", e.getMessage()), android.widget.Toast.LENGTH_LONG).show());
                }
            }
            // 分享文件时 EXTRA_TEXT 常是标题之类的附带说明，只有单纯分享文字时才插进去
            if (n == 0 && uris.isEmpty() && text != null) toPage("ccapp-insert", text);
        }, "share-in").start();
    }
    /** 页面可能还在启动：等 __cc 就绪再派发（app.js 里有对应的监听） */
    private void toPage(String event, String value) {
        ui.post(() -> {
            if (web == null) return;
            web.evaluateJavascript("(function f(n){if(window.__cc&&window.__cc.view){window.dispatchEvent(new CustomEvent(" + org.json.JSONObject.quote(event)
                + ",{detail:{value:" + org.json.JSONObject.quote(value) + "}}))}else if(n<150)setTimeout(function(){f(n+1)},200)})(0)", null);
        });
    }
    private String displayName(android.net.Uri u) {
        try (android.database.Cursor c = getContentResolver().query(u, new String[]{android.provider.OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst() && c.getString(0) != null) return c.getString(0);
        } catch (Exception ignored) {}
        String s = u.getLastPathSegment();
        return s == null ? "shared.bin" : s.substring(s.lastIndexOf('/') + 1);
    }

    /** 从「已完成」通知点进来：切到那个会话（界面正显示它就不动）。页面可能还在启动，等 __cc 就绪 */
    private void openSession(String sid) {
        if (web == null || sid == null || !sid.matches("[0-9A-Za-z-]{8,64}")) return;
        web.evaluateJavascript("(function f(n){var c=window.__cc;if(c&&c.view){setTimeout(function(){if(c.view.sessionId!==\"" + sid
            + "\")c.openSession(\"" + sid + "\")},n?800:0)}else if(n<50)setTimeout(function(){f(n+1)},200)})(0)", null);
    }

    // ── 工具包从哪装：GitHub / cccodroid.net 镜像 / 本地文件 ──────────────────
    /** 首装：让用户选来源，照着走。两个下载源互为备用（首选连着失败就换另一个接着续传）；本地文件没选就回到选择 */
    private void installFirstDevkit(Installer ins) throws Exception {
        org.json.JSONObject pin = Updater.devkitPin(this);
        if (pin == null || pin.optJSONObject("gz") == null) throw new java.io.IOException(Tr.t("APK 里的工具包清单坏了"));
        String file = pin.getJSONObject("gz").getString("file"), base = pin.getString("base");
        String gh = base + file, mirror = Updater.devkitMirror(base, file);
        String local = null;
        for (String l : LOCAL_DEVKIT) if (new File(l).canRead()) { local = l; break; }
        while (true) {
            String c = chooseDevkitSource(pin, local);
            if ("github".equals(c) || "mirror".equals(c)) {
                boolean m = "mirror".equals(c);
                File gz = ins.downloadDevkit(pin, m ? mirror : gh, m ? gh : mirror);
                ins.installDevkit(gz.getPath());
                gz.delete();      // 解完就删，腾出 650 MB
                return;
            }
            Uri uri = "path".equals(c) ? Uri.fromFile(new File(local)) : pickDevkitBlocking();
            if (uri == null) { say(Tr.t("没选文件")); continue; }
            if (installLocal(ins, uri, false)) return;
        }
    }

    /** 在安装页上摆出来源选择，等用户点一个。返回 github / mirror / local / path */
    private String chooseDevkitSource(org.json.JSONObject pin, String local) throws InterruptedException {
        final String[] pick = {null};
        CountDownLatch done = new CountDownLatch(1);
        SharedPreferences sp = getSharedPreferences("ui", MODE_PRIVATE);
        String last = sp.getString("devkitSrc", "");
        org.json.JSONObject gz = pin.optJSONObject("gz"), tar = pin.optJSONObject("tar");
        File part = new File(env.files, gz.optString("file") + ".part");
        ui.post(() -> {
            boolean dark = uiDark();
            int fg = BrowserPane.pal(MainActivity.this, dark, "fg"), dim = BrowserPane.pal(MainActivity.this, dark, "dim");
            int line = BrowserPane.pal(MainActivity.this, dark, "line"), accent = BrowserPane.pal(MainActivity.this, dark, "accent");
            chooser.removeAllViews();
            TextView q = new TextView(this);
            q.setTextColor(fg);
            q.setTextSize(14);
            q.setPadding(0, dp(4), 0, dp(8));
            String txt = Tr.f("开发工具包约 {0} MB（解开后约 {1} GB），从哪里装？",
                String.valueOf(gz.optLong("bytes") >> 20), String.format(java.util.Locale.ROOT, "%.1f", (tar != null ? tar.optLong("bytes") : 0) / 1073741824.0));
            if (part.length() > 0) txt += "\n" + Tr.f("已经下了 {0} MB，两个下载源都能接着续传。", String.valueOf(part.length() >> 20));
            q.setText(txt);
            chooser.addView(q);
            String[][] opts = {
                {"github", Tr.t("从 GitHub 下载"), Tr.t("海外网络一般最快")},
                {"mirror", Tr.t("从 cccodroid.net 镜像下载"), Tr.t("GitHub 慢或连不上时用；文件与 GitHub 上的一致，照样核对 sha256")},
                {"local", Tr.t("选择本地文件…"), Tr.t("已经下好的 devkit-cc.codroid.tar.gz（或 .tar）；装之前核对是不是发布版")},
                local != null ? new String[]{"path", Tr.t("用共享目录里的文件"), local} : null,
            };
            for (String[] o : opts) {
                if (o == null) continue;
                LinearLayout card = new LinearLayout(this);
                card.setOrientation(LinearLayout.VERTICAL);
                card.setPadding(dp(14), dp(10), dp(14), dp(10));
                android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
                bg.setCornerRadius(dp(10));
                bg.setStroke(dp(1), o[0].equals(last) ? accent : line);
                card.setBackground(bg);
                TextView t1 = new TextView(this);
                t1.setText(o[1] + (o[0].equals(last) ? "  · " + Tr.t("上次选的") : ""));
                t1.setTextColor(fg);
                t1.setTextSize(15);
                TextView t2 = new TextView(this);
                t2.setText(o[2]);
                t2.setTextColor(dim);
                t2.setTextSize(12);
                card.addView(t1);
                card.addView(t2);
                card.setClickable(true);
                card.setOnClickListener(v -> {
                    if (pick[0] != null) return;
                    pick[0] = o[0];
                    sp.edit().putString("devkitSrc", o[0]).apply();
                    chooser.setVisibility(View.GONE);
                    done.countDown();
                });
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
                lp.bottomMargin = dp(8);
                chooser.addView(card, lp);
            }
            chooser.setVisibility(View.VISIBLE);
        });
        done.await();
        return pick[0];
    }

    private static Intent devkitPickIntent() {
        return new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
    }

    /** 首装：弹系统文件选择器并等它回来；没选返回 null */
    private Uri pickDevkitBlocking() throws InterruptedException {
        CountDownLatch l = new CountDownLatch(1);
        picked = null;
        pickWait = l;
        ui.post(() -> {
            try { startActivityForResult(devkitPickIntent(), REQ_DEVKIT); }
            catch (Exception e) { say("✗ " + e.getMessage()); l.countDown(); }
        });
        l.await();
        pickWait = null;
        return picked;
    }

    private InputStream openUri(Uri u) throws java.io.IOException {
        if ("file".equals(u.getScheme())) return new java.io.FileInputStream(u.getPath());
        InputStream in = getContentResolver().openInputStream(u);
        if (in == null) throw new java.io.IOException(Tr.t("读不了这个文件"));
        return in;
    }

    private long sizeOf(Uri u) {
        if ("file".equals(u.getScheme())) return new File(u.getPath()).length();
        try (android.database.Cursor c = getContentResolver().query(u, new String[]{android.provider.OpenableColumns.SIZE}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getLong(0);
        } catch (Exception ignored) {}
        return -1;
    }

    /** 后台线程里弹一个确认框并等结果 */
    private boolean askBlocking(String msg, String yes) throws InterruptedException {
        final boolean[] ok = {false};
        CountDownLatch l = new CountDownLatch(1);
        ui.post(() -> new android.app.AlertDialog.Builder(this).setMessage(msg)
            .setPositiveButton(yes, (d, w) -> ok[0] = true)
            .setNegativeButton(Tr.t("取消"), null)
            .setOnDismissListener(d -> l.countDown()).show());
        l.await();
        return ok[0];
    }

    /**
     * 本地工具包：先读一遍算 sha256、对照已发布的清单认身份；认不出就明说风险、让用户决定；认出来但不兼容就不装。
     * 第二遍解包时再按清单的 tar sha256 边解边核，两遍之间文件被换掉也会被拦下。
     * @param replacing true = 更新卡片发起、替换已装的（要停网关）；false = 首装
     * @return false = 用户取消
     */
    private boolean installLocal(Installer ins, Uri uri, boolean replacing) throws Exception {
        Updater upd = Updater.get(this);
        long total = sizeOf(uri);
        Installer.Source src = () -> openUri(uri);
        String[] scan = ins.scanLocal(src, total);
        say("sha256 " + scan[0]);
        say(Tr.t("对照已发布的工具包…"));
        org.json.JSONObject id = upd.identifyDevkit(scan[0]);
        if (id == null) {
            if (!askBlocking(Tr.f("这个文件不是已发布的工具包（也可能是现在没网、查不到清单）。\n\nsha256 前 12 位：{0}\n\n只在它是你自己构建的、或者确定来源可靠时才继续：工具包里的程序能读写 cccodroid 里的一切。", scan[0].substring(0, 12)),
                    Tr.t("仍然安装"))) { say(Tr.t("已取消")); return false; }
            say("⚠ " + Tr.t("没核对上来源，按你的确认继续"));
        } else {
            String why = upd.devkitIncompatible(id);
            if (why != null) throw new java.io.IOException(why);
            say(Tr.f("✓ 是已发布的 {0}", id.optString("tag")));
        }
        boolean gzip = "gz".equals(scan[1]);
        if (replacing) upd.applyLocalDevkit(ins, src, total, gzip, scan[0], id);
        else ins.installDevkit(src.open(), total, gzip, id != null ? id.optString("base") : "",
            id != null && !id.optString("sha256").isEmpty() ? id.optString("sha256") : scan[0], id != null ? id.optString("tarSha256", null) : null);
        return true;
    }

    /** 更新卡片的「从本地文件安装」：选好文件后切到进度页，认身份、替换，装完回到界面 */
    private void applyLocalDevkitUi(Uri uri) {
        Updater upd = Updater.get(this);
        new Thread(() -> {
            if (Updater.gatewayBusy() || upd.devkitMoving()) {
                ui.post(() -> android.widget.Toast.makeText(this, Tr.t("有任务正在跑，等它结束再更新开发工具包"), android.widget.Toast.LENGTH_LONG).show());
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
                say(Tr.t("从本地文件安装开发工具包…"));
                boolean done = installLocal(new Installer(env, new Installer.Progress() {
                    public void step(String m) { say(m); }
                    public void bytes(long d, long t) { progress(d, t); }
                }), uri, true);
                if (done) say(Tr.t("✓ 开发工具包已更新，等待网关…"));
            } catch (Exception e) {
                say("✗ " + e.getMessage());
                say(Tr.t("（旧的工具包已经不在了的话，划掉应用重新打开会重新安装）"));
                try { Thread.sleep(4000); } catch (InterruptedException ignored) {}
            }
            try { for (int i = 0; i < 120 && !ping(); i++) Thread.sleep(500); } catch (InterruptedException ignored) {}
            ui.post(() -> { showWeb(); booted = true; });
        }, "devkit-local").start();
    }

    /** 替换工具包：网关要停，界面切回进度页，装完再回来 */
    private void applyDevkitUi() {
        Updater upd = Updater.get(this);
        if (!upd.devkitStaged()) { upd.apply("devkit", true); return; }     // 还没下：先下，下完会再走到这里
        new Thread(() -> {
            if (Updater.gatewayBusy()) {
                ui.post(() -> android.widget.Toast.makeText(this, Tr.t("有任务正在跑，等它结束再更新开发工具包"), android.widget.Toast.LENGTH_LONG).show());
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
                say(Tr.t("更新开发工具包…"));
                upd.applyDevkit(new Installer(env, new Installer.Progress() {
                    public void step(String m) { say(m); }
                    public void bytes(long d, long t) { progress(d, t); }
                }));
                say(Tr.t("✓ 开发工具包已更新，等待网关…"));
            } catch (Exception e) {
                say("✗ " + e.getMessage());
                say(Tr.t("（旧的工具包已经不在了的话，划掉应用重新打开会重新安装）"));
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
        say(Tr.t("部署界面与网关 ") + want.trim());
        // boot() 一开头就起了网关服务，守护线程可能已经拿旧的 server.mjs 把 node 拉起来了 ——
        // 不停一下，升级后界面是新的、网关还是旧的（新接口全 404），直到下次重启。
        // 只在内容哈希变了（= 刚升级，进程本来就被安装杀过）时走到这里，不会打断任务
        GatewayService.pause(true);
        try {
            Installer.deleteTree(env.app);
            copyAssetDir("app", env.app);
            // lib/ 里除了 .so 还有可执行的 seccomp-enosys-run、ptyhost
            for (String d : new String[]{"scripts", "bin", "pre", "lib"}) {
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
            .setTitle(Tr.t("开启通知"))
            .setMessage(Tr.t("cccodroid 在后台跑任务时靠一条常驻通知保活；任务完成或需要你确认时也通过通知提醒。\n\n系统目前屏蔽了本应用的通知，去设置里打开吧。"))
            .setPositiveButton(Tr.t("去开启"), (d, w) -> {
                try {
                    startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
                } catch (Exception e) {
                    startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
                }
            })
            .setNegativeButton(Tr.t("以后再说"), null)
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
        int accent = BrowserPane.pal(this, dark, "accent");
        root = new FrameLayout(this);
        root.setBackgroundColor(BrowserPane.pal(this, dark, "bg"));
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
        bar.setProgressBackgroundTintList(android.content.res.ColorStateList.valueOf(BrowserPane.pal(this, dark, "line")));
        col.addView(bar, new LinearLayout.LayoutParams(-1, dp(8)));
        stat = new TextView(this);
        stat.setTextColor(BrowserPane.pal(this, dark, "fg"));
        stat.setTextSize(12.5f);
        stat.setPadding(0, dp(6), 0, dp(10));
        stat.setTypeface(android.graphics.Typeface.MONOSPACE);
        col.addView(stat);
        log = new TextView(this);
        log.setTextColor(BrowserPane.pal(this, dark, "dim"));   // 原始输出压暗一档，进度和结论靠上面那行
        log.setTextSize(11.5f);
        log.setLineSpacing(0, 1.15f);
        log.setTypeface(android.graphics.Typeface.MONOSPACE);
        logScroll = new ScrollView(this);
        logScroll.addView(log);
        col.addView(logScroll, new LinearLayout.LayoutParams(-1, 0, 1));
        retry = new android.widget.Button(this);
        retry.setText(Tr.t("重试"));
        retry.setVisibility(View.GONE);
        retry.setOnClickListener(v -> { retry.setVisibility(View.GONE); stuck.setVisibility(View.GONE); say(Tr.t("— 重试 —")); boot(); });
        // 「我卡住了」：界面还没起来时（安装就失败了）也能把诊断包发出去
        stuck = new android.widget.Button(this);
        stuck.setText(Tr.t("我卡住了：分享诊断"));
        stuck.setVisibility(View.GONE);
        stuck.setOnClickListener(v -> new android.app.AlertDialog.Builder(this)
            .setTitle(Tr.t("打包诊断信息"))
            .setMessage(Share.contents())
            .setPositiveButton(Tr.t("打包并分享"), (d, w) -> new Thread(() -> {
                try { Share.send(this, Share.bundleLogs(this), "application/zip"); }
                catch (Exception e) { say(Tr.t("✗ 诊断包没打成：") + e.getMessage()); }
            }, "stuck").start())
            .setNegativeButton(Tr.t("取消"), null).show());
        chooser = new LinearLayout(this);
        chooser.setOrientation(LinearLayout.VERTICAL);
        chooser.setVisibility(View.GONE);
        col.addView(chooser, new LinearLayout.LayoutParams(-1, -2));
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
                txt += " · " + mb((long) speed) + "/s · " + (eta >= 60 ? Tr.f("剩约 {0} 分", eta / 60) : Tr.f("剩约 {0} 秒", eta));
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
        web = new WebView(this) {
            @Override public boolean dispatchTouchEvent(android.view.MotionEvent e) {
                if (e.getActionMasked() == android.view.MotionEvent.ACTION_UP) { hangCheck(); imeCheck(); }
                return super.dispatchTouchEvent(e);
            }
            @Override public android.view.inputmethod.InputConnection onCreateInputConnection(android.view.inputmethod.EditorInfo o) {
                android.view.inputmethod.InputConnection ic = super.onCreateInputConnection(o);
                imeNoConn = ic == null;
                return ic;
            }
        };
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.setBackgroundColor(BrowserPane.pal(this, uiDark(), "bg"));
        // 本机网关之外的地址一律交给系统浏览器：登录授权页、"去官网创建 Key" 之类。
        // 在 WebView 里打开登录页会被 Google 等拒绝，而且 OAuth 回调要回到浏览器才能跳 localhost。
        web.setWebViewClient(new WebViewClient() {
            // 只管整页跳转：查看器里 HTML 预览的 iframe 在里面点链接，留在预览里，别当外链甩出去
            @Override public boolean shouldOverrideUrlLoading(WebView v, android.webkit.WebResourceRequest req) {
                if (!req.isForMainFrame()) return false;
                return shouldOverrideUrlLoading(v, req.getUrl().toString());
            }
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
                if (isGatewayUrl(url)) return;
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
                if (isGatewayUrl(url)) return;
                if (url == null || url.isEmpty() || url.startsWith("https://") || url.startsWith("http://"))
                    ui.post(() -> BrowserActivity.open(MainActivity.this, url));
            }
            /** 回复底下的「转发」：把正文交给系统分享面板 */
            @android.webkit.JavascriptInterface public void shareText(String text) {
                if (text != null && !text.isEmpty()) ui.post(() -> shareTextNow(text));
            }
            /** 冻结脱困：WebView 偶发把这个文档的触摸滚动整个吞掉，同站重载不好，跨站跳一次再回来才好。见 bounce() */
            /** 更新卡片的「从本地文件安装」：弹系统文件选择器，选好后由 applyLocalDevkitUi 接手 */
            @android.webkit.JavascriptInterface public void pickDevkit() {
                ui.post(() -> { pickWait = null; try { startActivityForResult(devkitPickIntent(), REQ_DEVKIT); } catch (Exception ignored) {} });
            }
            @android.webkit.JavascriptInterface public void unfreeze() { ui.post(() -> bounce()); }
            /** 更新说明（见 WhatsNew）：页面启动时来取，显示出来后调 whatsNewSeen */
            @android.webkit.JavascriptInterface public String whatsNew(String lang) { return WhatsNew.pending(MainActivity.this, lang); }
            @android.webkit.JavascriptInterface public void whatsNewSeen() { WhatsNew.seen(MainActivity.this); }
            @android.webkit.JavascriptInterface public boolean nightMode() { return systemNight(); }
            @android.webkit.JavascriptInterface public void setBars(boolean dark) { ui.post(() -> applyBars(dark)); }
            /** 界面里的风格（native / qiusuo）：状态栏、安装页、对话框、内置浏览器的颜色按它取。theme.js 在 setBars 之前调 */
            @android.webkit.JavascriptInterface public void skinPref(String s) {
                if ("native".equals(s) || "qiusuo".equals(s))
                    getSharedPreferences("ui", MODE_PRIVATE).edit().putString("skin", s).commit();
            }
            /** 界面里的外观设置（auto / light / dark），下次启动时安装页照着上色 */
            /** 界面最终用的语言（i18n.js 解析过的 code，不是 auto）：外壳的通知、安装页、更新文案跟着换 */
            @android.webkit.JavascriptInterface public void langPref(String code) { Tr.set(code); }
            @android.webkit.JavascriptInterface public void themePref(String p) {
                if ("auto".equals(p) || "light".equals(p) || "dark".equals(p))
                    getSharedPreferences("ui", MODE_PRIVATE).edit().putString("theme", p).commit();
                ui.post(MainActivity.this::syncSplash);
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
                try { startActivityForResult(chooserIntent(p), 7); } catch (Exception e) { fileCb = null; return false; }
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
        // 首次启动：安装界面的原生控件刚被整个拿掉，紧接着还可能弹「开启通知」对话框。WebView 没拿到焦点时，
        // 点输入框键盘起不来 / 字打不进去，只有脱困（整页重载）才好。这里主动要焦点，窗口回到前台时再补一次（onWindowFocusChanged）
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        web.requestFocus();
    }

    // ── 冻结脱困 ─────────────────────────────────────────────────────
    //  2026-10-16 实测：触摸滚动冻住后 location.reload() 和切后台都不好，跳到 127.0.0.2:9 再跳回来就好 ——
    //  卡住的是 WebView 给这个文档的手势状态，换站点才会重建。127.0.0.2:9 是浏览器直接拒绝的端口，不发任何网络请求。
    //  loadUrl 不经过 shouldOverrideUrlLoading，不会被当外链拦掉。跳的那一下先把 WebView 藏起来，免得闪错误页。
    // ── 输入法拿着空连接 ──
    //  「首启打不了中文」的真因（2026-10-21 输入法事件流实测）：页面一加载完，新会话就用 JS 把焦点放进输入框，
    //  这时没有键盘、也没人点，WebView 不会为它新建输入连接，输入法手里还是页面刚出来时那条空连接（没有可编辑处时给的）。
    //  之后手指点输入框，焦点没变，WebView 只叫键盘出来、不重建连接，于是讯飞照常出候选，选的字却交给了空连接，一个也进不去。
    //  英文能进，多半是输入法在没有连接时退回去发按键事件（还没单独验证）。分屏 / 切屏让窗口失焦再得焦，连接重建，所以又好了。
    //  这里在手指抬起后看一眼：页面焦点在可编辑处、手里的连接却还是空的，就让输入法重新连一次。
    private boolean imeNoConn = false;
    private void imeCheck() {
        ui.postDelayed(() -> {
            if (web == null || !imeNoConn || !web.hasFocus()) return;
            web.evaluateJavascript("(function(){var a=document.activeElement;return !!a&&(a.isContentEditable||/^(TEXTAREA|INPUT)$/.test(a.tagName))})()", v -> {
                if (!"true".equals(v) || web == null || !imeNoConn) return;
                android.view.inputmethod.InputMethodManager m = getSystemService(android.view.inputmethod.InputMethodManager.class);
                if (m != null) m.restartInput(web);
            });
        }, 300);
    }

    // ── 页面卡死兜底 ──
    //  滑动在 WebView 的合成线程上做，点按要页面的 JS 主线程处理。主线程卡住（死循环、或者等一个没显示出来的对话框）时，
    //  内容照样能滑、什么都点不动，页面里的雪花按钮也救不了。这里在原生层看：手指抬起时问页面一句，
    //  6 秒没回答（又没有正开着的对话框）就弹原生对话框问要不要重新载入。重新载入走 bounce()，回话在网关那边照常跑。
    private int jsDialogs = 0;
    private boolean hangPending = false, hangAsked = false;
    private void hangCheck() {
        if (hangPending || hangAsked || web == null || bounceStage != 0 || jsDialogs > 0) return;
        hangPending = true;
        final boolean[] alive = { false };
        web.evaluateJavascript("1", v -> alive[0] = true);
        ui.postDelayed(() -> {
            hangPending = false;
            if (alive[0] || web == null || bounceStage != 0 || jsDialogs > 0 || isFinishing()) return;
            hangAsked = true;
            boolean dark = uiDark();
            try {
                android.app.AlertDialog d = new android.app.AlertDialog.Builder(this,
                        dark ? android.R.style.Theme_Material_Dialog_Alert : android.R.style.Theme_Material_Light_Dialog_Alert)
                    .setMessage(Tr.t("页面没有响应，点什么都没反应？重新载入一下就好，正在进行的回复不受影响。"))
                    .setPositiveButton(Tr.t("重新载入"), (x, w) -> bounce())
                    .setNegativeButton(Tr.t("再等等"), null)
                    .setOnDismissListener(x -> hangAsked = false)
                    .show();
                int accent = BrowserPane.pal(this, dark, "accent");
                d.getWindow().setBackgroundDrawable(roundBg(BrowserPane.pal(this, dark, "card")));
                for (int k : new int[] { android.app.AlertDialog.BUTTON_POSITIVE, android.app.AlertDialog.BUTTON_NEGATIVE }) {
                    android.widget.Button bt = d.getButton(k);
                    if (bt != null) bt.setTextColor(accent);
                }
            } catch (Exception e) { hangAsked = false; }
        }, 6000);
    }

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
        // 页面的 confirm / alert / prompt 会一直停着等这个结果。对话框要是没回答就没了（分屏、旋转、窗口重建时系统直接收走，
        // 不走 OnCancel），页面 JS 就永远卡住：内容还能滑，所有按钮和输入框都点不动，连雪花都没用（2026-10-21 群友报）。
        // 所以只认一次回答，对话框不管怎么消失，没回答就当取消。
        final boolean[] answered = { false };
        final Runnable cancel = () -> { if (!answered[0]) { answered[0] = true; r.cancel(); } };
        android.app.AlertDialog.Builder b = new android.app.AlertDialog.Builder(this,
                dark ? android.R.style.Theme_Material_Dialog_Alert : android.R.style.Theme_Material_Light_Dialog_Alert)
            .setMessage(msg).setCancelable(true)
            .setOnCancelListener(d -> cancel.run())
            .setOnDismissListener(d -> { cancel.run(); jsDialogs--; });
        if (in != null) b.setView(in);
        b.setPositiveButton(android.R.string.ok, (d, w) -> {
            if (answered[0]) return;
            answered[0] = true;
            if (pr != null) pr.confirm(in.getText().toString()); else r.confirm();
        });
        if (withCancel) b.setNegativeButton(android.R.string.cancel, (d, w) -> cancel.run());
        jsDialogs++;
        try {
            android.app.AlertDialog d = b.show();
            int accent = BrowserPane.pal(this, dark, "accent");
            d.getWindow().setBackgroundDrawable(roundBg(BrowserPane.pal(this, dark, "card")));
            for (int k : new int[] { android.app.AlertDialog.BUTTON_POSITIVE, android.app.AlertDialog.BUTTON_NEGATIVE }) {
                android.widget.Button bt = d.getButton(k);
                if (bt != null) bt.setTextColor(accent);
            }
        } catch (Exception e) { jsDialogs = 0; cancel.run(); }
    }
    private android.graphics.drawable.Drawable roundBg(int color) {
        android.graphics.drawable.GradientDrawable g = new android.graphics.drawable.GradientDrawable();
        g.setColor(color);
        g.setCornerRadius(dp(16));
        return new android.graphics.drawable.InsetDrawable(g, dp(16));
    }

    private void openExternal(String url) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
        catch (Exception e) { android.widget.Toast.makeText(this, Tr.t("没有可用的浏览器：") + url, android.widget.Toast.LENGTH_LONG).show(); }
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
                if (out == null) throw new java.io.IOException(Tr.t("openOutputStream 返回 null"));
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
        if (req == REQ_DEVKIT) {
            Uri u = res == RESULT_OK && data != null ? data.getData() : null;
            CountDownLatch w = pickWait;
            if (w != null) { picked = u; w.countDown(); }
            else if (u != null) applyLocalDevkitUi(u);
            return;
        }
        if (req == 8) {
            if (res == RESULT_OK && data != null && data.getData() != null) finishSaveAs(data.getData());
            else { savePending = null; savedJs(false, "cancel"); }
            return;
        }
        if (req == 7 && fileCb != null) {
            fileCb.onReceiveValue(chooserResult(res, data));
            fileCb = null;
        }
    }

    /** 系统给的 createIntent() 不管网页要不要多选，一律只能选一个：<input multiple> 时补上 EXTRA_ALLOW_MULTIPLE */
    /** 网关自己的地址不许进浏览器 / 窗格：它们和界面共用 Cookie，预览页里的脚本能借这个桥拿到网关权限 */
    static boolean isGatewayUrl(String url) {
        if (url == null || url.isEmpty()) return false;
        try {
            Uri u = Uri.parse(url.trim());
            String h = u.getHost();
            if (h == null) return false;
            h = h.toLowerCase(java.util.Locale.ROOT);
            boolean local = h.equals("127.0.0.1") || h.equals("localhost") || h.equals("[::1]") || h.equals("::1") || h.equals("0.0.0.0");
            return local && u.getPort() == Env.PORT;
        } catch (Exception e) { return true; }
    }

    static Intent chooserIntent(WebChromeClient.FileChooserParams p) {
        Intent i = p.createIntent();
        if (p.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        return i;
    }

    /** 系统的 parseResult() 只读 getData()：一次选了多个时文件在 ClipData 里，它会返回空，结果一个都附加不上 */
    static Uri[] chooserResult(int res, Intent data) {
        if (res != RESULT_OK || data == null) return null;
        android.content.ClipData c = data.getClipData();
        if (c != null && c.getItemCount() > 0) {
            java.util.ArrayList<Uri> out = new java.util.ArrayList<>();
            for (int i = 0; i < c.getItemCount(); i++) { Uri u = c.getItemAt(i).getUri(); if (u != null) out.add(u); }
            if (!out.isEmpty()) return out.toArray(new Uri[0]);
        }
        return data.getData() != null ? new Uri[] { data.getData() } : null;
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
