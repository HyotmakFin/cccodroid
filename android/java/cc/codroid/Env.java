package cc.codroid;

import android.content.Context;
import java.io.File;
import java.util.Map;

/** 目录布局与子进程环境。前缀固定为 /data/data/cc.codroid/files/usr —— devkit 按它等长改写过。 */
final class Env {
    static final int PORT = 8791;

    /** 网关访问令牌（server.mjs 首次启动时生成，0600，存在应用私有目录）。见 server.mjs「访问控制」 */
    private static volatile File tokenFile = new File("/data/data/cc.codroid/files/home/.gateway-token");

    static String token() {
        try { return new String(java.nio.file.Files.readAllBytes(tokenFile.toPath()), "UTF-8").trim(); }
        catch (Exception e) { return ""; }
    }

    /** 连本机网关：自动带上令牌头。网关没生成令牌前会得到 403，调用方照"没就绪"处理即可 */
    static java.net.HttpURLConnection gateway(String path) throws java.io.IOException {
        java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL("http://127.0.0.1:" + PORT + path).openConnection();
        c.setRequestProperty("X-CC-Token", token());
        return c;
    }

    /** WebView 首次加载的地址：带 ?t= 让网关种 Cookie */
    static String uiUrl() {
        String t = token();
        return "http://127.0.0.1:" + PORT + "/" + (t.isEmpty() ? "" : "?t=" + t);
    }

    final File files, usr, home, app, log;

    Env(Context c) {
        files = c.getFilesDir();
        usr = new File(files, "usr");
        home = new File(files, "home");
        app = new File(files, "app");
        log = new File(home, "gateway.log");
        tokenFile = new File(home, ".gateway-token");
    }

    File bin(String name) { return new File(usr, "bin/" + name); }

    boolean devkitReady() { return new File(usr, ".devkit-ok").isFile() && bin("node").canExecute(); }

    /** 已装工具包的来历（Installer 写的 JSON：base、sha256）。早期版本里只有一行 "ok" → 空对象 */
    org.json.JSONObject devkitInfo() {
        try { return new org.json.JSONObject(new String(java.nio.file.Files.readAllBytes(new File(usr, ".devkit-ok").toPath()), "UTF-8")); }
        catch (Exception e) { return new org.json.JSONObject(); }
    }

    /** 官方 Claude Code：install-claude.sh 装好后写下的版本指针 */
    File claude() { return new File(home, ".local/share/cccodroid/claude/current/claude"); }

    boolean claudeReady() { return claude().canExecute(); }

    /**
     * 工作区放在私有目录。/sdcard 是 FUSE：不能执行程序、不能建符号链接、git 嫌属主不对、
     * npm install 建不了 .bin —— 实测在那里几乎干不了开发。私有目录里这些都正常，界面的文件浏览器也看得到。
     */
    File workspace() {
        File p = new File(home, "workspace");
        p.mkdirs();
        return p;
    }

    /** 与别的应用交换文件的地方（交付的 APK、截图之类）。拿不到存储权限时为 null */
    File shared() {
        File w = new File("/sdcard/cccodroid");
        if ((w.isDirectory() || w.mkdirs()) && w.canWrite()) return w;
        return null;
    }

    void apply(Map<String, String> e) {
        e.remove("LD_LIBRARY_PATH");
        e.remove("LD_PRELOAD");
        e.put("PREFIX", usr.getPath());
        e.put("HOME", home.getPath());
        e.put("TMPDIR", new File(usr, "tmp").getPath());
        // app/pre 在最前：只放 pkg / apt（压过工具包里同名的旧说明替身）
        e.put("PATH", new File(app, "pre").getPath() + ":" + usr.getPath() + "/bin:" + new File(app, "bin").getPath() + ":/system/bin:/system/xbin");
        e.put("LANG", "en_US.UTF-8");
        e.put("TERM", "xterm-256color");
        // typst 自带的只有拉丁字体，不给它路径中文就渲染成空白方框；安卓的字体都在 /system/fonts
        e.put("TYPST_FONT_PATHS", "/system/fonts");
        e.put("SHELL", bin("bash").getPath());
        // 网关（server.mjs）认的变量
        e.put("CCAPP_PREFIX", usr.getPath());
        e.put("CCAPP_HOME", home.getPath());
        e.put("CCAPP_RUNTIME", files.getPath());
        e.put("CCAPP_WORKSPACE", workspace().getPath());
        File sh = shared();
        if (sh != null) e.put("CCAPP_SHARED", sh.getPath());
        e.put("CCAPP_PORT", String.valueOf(PORT));
        e.put("CCAPP_TOKEN_FILE", new File(home, ".gateway-token").getPath());
        e.put("CCAPP_SHELL", bin("bash").getPath());
        e.put("CCAPP_LOADER", new File(usr, "glibc/lib/ld-linux-aarch64.so.1").getPath());
        e.put("CCAPP_GLIBC_LIB", new File(usr, "glibc/lib").getPath());
        e.put("CCAPP_CLAUDE", claude().getPath());
        // ld-linux --preload 给 claude 挂上：被 seccomp 拦下的调用改回 ENOSYS（Android 14 拦 epoll_pwait2）
        e.put("CCAPP_CLAUDE_PRELOAD", new File(app, "lib/seccomp-enosys.so").getPath());
        e.put("CCAPP_LOG", log.getPath());
        e.put("CCAPP_LEDGER", Ledger.file(this).getPath());   // 修复账本：网关记安全模式、界面能翻
        e.put("CCAPP_SEED", new File(home, "seed.json").getPath());
        e.put("CCAPP_BIN", new File(app, "bin").getPath());   // 应用自带的小工具（priv）
    }
}
