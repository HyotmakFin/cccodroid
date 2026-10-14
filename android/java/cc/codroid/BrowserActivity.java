package cc.codroid;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.util.Log;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 应用内浏览器：看本机开发服务（http://127.0.0.1:端口）和回复里的网页链接。
 *
 * 用的是系统 WebView —— 它本身就是 Chromium，手机里已经有了，这里不额外带任何引擎。
 * 和对话界面的 WebView 完全隔开：不挂 CCApp 桥，网页拿不到应用的任何接口。
 * 登录授权页（OAuth）不走这里，仍交给系统浏览器（WebView 里登录会被 Google 等拒绝）。
 *
 * 不用 lambda：开发端的构建链（同一份源码改包名）不支持。
 */
public class BrowserActivity extends Activity {
    static final String EXTRA_URL = "url";
    private static final String PREFS = "browser", LAST = "last", TAG = "cccodroid-browser";

    private WebView web;
    private EditText bar;
    private ProgressBar prog;
    private TextView back, fwd;
    private ValueCallback<Uri[]> fileCb;

    /** 从对话界面打开：url 为空就回到上次看的那页 */
    static void open(Context c, String url) {
        Intent i = new Intent(c, BrowserActivity.class);
        if (url != null && url.length() > 0) i.putExtra(EXTRA_URL, url);
        c.startActivity(i);
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        Log.i(TAG, "onCreate saved=" + (b != null));
        boolean night = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        int bg = night ? Color.parseColor("#1f1e1d") : Color.parseColor("#f5f4ef");
        int fg = night ? Color.parseColor("#e8e6e1") : Color.parseColor("#2b2a27");
        int field = night ? Color.parseColor("#2c2b29") : Color.WHITE;
        getWindow().setStatusBarColor(bg);
        getWindow().setNavigationBarColor(bg);
        if (!night) getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(bg);

        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.setPadding(dp(4), dp(4), dp(4), dp(4));
        back = btn("‹", fg, "后退");
        fwd = btn("›", fg, "前进");
        TextView reload = btn("⟳", fg, "刷新");
        bar = new EditText(this);
        bar.setSingleLine(true);
        bar.setTextSize(14);
        bar.setTextColor(fg);
        bar.setHintTextColor(Color.GRAY);
        bar.setHint("网址，或 127.0.0.1:端口");
        bar.setBackground(new ColorDrawable(field));
        bar.setPadding(dp(10), dp(6), dp(10), dp(6));
        bar.setImeOptions(EditorInfo.IME_ACTION_GO);
        bar.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        bar.setSelectAllOnFocus(true);
        TextView ext = btn("↗", fg, "用系统浏览器打开");
        TextView close = btn("✕", fg, "关闭");
        top.addView(back); top.addView(fwd); top.addView(reload);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1);
        lp.setMargins(dp(4), 0, dp(4), 0);
        top.addView(bar, lp);
        top.addView(ext); top.addView(close);
        root.addView(top);

        prog = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        prog.setMax(100);
        root.addView(prog, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(3)));

        web = new WebView(this);
        web.setBackgroundColor(night ? Color.parseColor("#1f1e1d") : Color.WHITE);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setSupportZoom(true);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setAllowFileAccess(false);                 // 网页不许读本机文件
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        root.addView(web, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);

        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return route(r.getUrl().toString());
            }
            @SuppressWarnings("deprecation")
            @Override public boolean shouldOverrideUrlLoading(WebView v, String url) { return route(url); }
            @Override public void onPageStarted(WebView v, String url, Bitmap icon) { Log.i(TAG, "start " + url); shown(url); }
            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) Log.w(TAG, "error " + e.getErrorCode() + " " + e.getDescription() + " " + r.getUrl());
            }
            @Override public boolean onRenderProcessGone(WebView v, android.webkit.RenderProcessGoneDetail d) {
                Log.w(TAG, "renderer gone crash=" + d.didCrash());
                finish();
                return true;
            }
            @Override public void onPageFinished(WebView v, String url) {
                Log.i(TAG, "finish " + url);
                shown(url);
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(LAST, url).apply();
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView v, int p) {
                prog.setProgress(p);
                prog.setVisibility(p >= 100 ? View.INVISIBLE : View.VISIBLE);
            }
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                try { startActivityForResult(p.createIntent(), 8); } catch (Exception e) { fileCb = null; return false; }
                return true;
            }
        });
        // 下载：交给系统（下载管理器 / 浏览器），这里不自己存文件
        web.setDownloadListener(new DownloadListener() {
            @Override public void onDownloadStart(String url, String ua, String cd, String mime, long len) { external(url); }
        });

        back.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { if (web.canGoBack()) web.goBack(); } });
        fwd.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { if (web.canGoForward()) web.goForward(); } });
        reload.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { web.reload(); } });
        ext.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { external(web.getUrl()); } });
        close.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { finish(); } });
        bar.setOnEditorActionListener(new TextView.OnEditorActionListener() {
            @Override public boolean onEditorAction(TextView v, int id, KeyEvent e) {
                go(bar.getText().toString());
                return true;
            }
        });

        if (b != null) web.restoreState(b);
        else load(getIntent());
    }

    @Override protected void onNewIntent(Intent i) {
        Log.i(TAG, "onNewIntent"); super.onNewIntent(i); setIntent(i); load(i); }

    private void load(Intent i) {
        String u = i == null ? null : i.getStringExtra(EXTRA_URL);
        if (u == null || u.length() == 0) u = getSharedPreferences(PREFS, MODE_PRIVATE).getString(LAST, null);
        if (u == null || u.length() == 0) {
            shown("");
            // 空白页：光标直接进地址栏、弹键盘（不然焦点会落在"后退"按钮上）
            bar.requestFocus();
            bar.postDelayed(new Runnable() { public void run() {
                InputMethodManager im = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
                if (im != null) im.showSoftInput(bar, InputMethodManager.SHOW_IMPLICIT);
            } }, 250);
            return;
        }
        go(u);
    }

    /** 地址栏输入 → 网址：带协议的原样；像主机名/IP:端口的补 http(s)；其余当搜索词 */
    private void go(String in) {
        String u = in == null ? "" : in.trim();
        Log.i(TAG, "go '" + u + "'");
        if (u.length() == 0) return;
        if (!u.matches("(?i)^[a-z][a-z0-9+.-]*:.*")) {
            if (u.matches("^(localhost|127\\.0\\.0\\.1|\\d{1,3}(\\.\\d{1,3}){3}|\\[[0-9a-fA-F:]+\\])(:\\d+)?(/.*)?$")) u = "http://" + u;
            else if (!u.contains(" ") && u.matches("^[^/]+\\.[a-zA-Z]{2,}(:\\d+)?(/.*)?$")) u = "https://" + u;
            else u = "https://www.bing.com/search?q=" + Uri.encode(u);
        }
        if (route(u)) return;
        web.loadUrl(u);
        web.requestFocus();
        InputMethodManager im = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (im != null) im.hideSoftInputFromWindow(bar.getWindowToken(), 0);
    }

    /** http/https 留在这里；其余协议（intent:、mailto:、market:、tel: …）交给系统。返回 true = 已处理 */
    private boolean route(String url) {
        if (url == null) return true;
        String l = url.toLowerCase(java.util.Locale.ROOT);
        if (l.startsWith("http://") || l.startsWith("https://") || l.startsWith("about:") || l.startsWith("data:") || l.startsWith("blob:")) return false;
        external(url);
        return true;
    }

    private void external(String url) {
        if (url == null || url.length() == 0) return;
        try {
            Intent i = url.startsWith("intent:") ? Intent.parseUri(url, Intent.URI_INTENT_SCHEME) : new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addCategory(Intent.CATEGORY_BROWSABLE);
            i.setComponent(null); i.setSelector(null);       // intent: 链接不许点名拉起任意组件
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Exception e) {
            Toast.makeText(this, "没有能打开它的应用：" + url, Toast.LENGTH_LONG).show();
        }
    }

    private void shown(String url) {
        if (!bar.hasFocus()) bar.setText(url == null ? "" : url);
        back.setAlpha(web.canGoBack() ? 1f : 0.35f);
        fwd.setAlpha(web.canGoForward() ? 1f : 0.35f);
    }

    private TextView btn(String label, int fg, String desc) {
        TextView t = new TextView(this);
        t.setText(label);
        t.setTextSize(20);
        t.setTextColor(fg);
        t.setGravity(Gravity.CENTER);
        t.setContentDescription(desc);
        t.setMinWidth(dp(40));
        t.setPadding(dp(6), dp(2), dp(6), dp(2));
        t.setBackgroundResource(android.R.drawable.list_selector_background);
        return t;
    }

    @Override protected void onSaveInstanceState(Bundle o) { super.onSaveInstanceState(o); web.saveState(o); }

    @Override protected void onActivityResult(int req, int res, Intent data) {
        if (req == 8 && fileCb != null) {
            fileCb.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data));
            fileCb = null;
        }
    }

    @Override public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else finish();
    }

    @Override protected void onPause() { super.onPause(); web.onPause(); CookieManager.getInstance().flush(); }
    @Override protected void onResume() { super.onResume(); web.onResume(); }
    @Override protected void onDestroy() {
        if (web != null) { web.stopLoading(); web.setWebChromeClient(null); web.destroy(); }
        super.onDestroy();
    }

    private int dp(int v) { return Math.round(getResources().getDisplayMetrics().density * v); }
}
