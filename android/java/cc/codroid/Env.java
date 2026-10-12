package cc.codroid;

import android.content.Context;
import java.io.File;
import java.util.Map;

/** 目录布局与子进程环境。前缀固定为 /data/data/cc.codroid/files/usr —— devkit 按它等长改写过。 */
final class Env {
    static final int PORT = 8791;

    final File files, usr, home, app, log;

    Env(Context c) {
        files = c.getFilesDir();
        usr = new File(files, "usr");
        home = new File(files, "home");
        app = new File(files, "app");
        log = new File(home, "gateway.log");
    }

    File bin(String name) { return new File(usr, "bin/" + name); }

    boolean devkitReady() { return new File(usr, ".devkit-ok").isFile() && bin("node").canExecute(); }

    /** 官方 Claude Code：install-claude.sh 装好后写下的版本指针 */
    File claude() { return new File(home, ".local/share/cccodroid/claude/current/claude"); }

    boolean claudeReady() { return claude().canExecute(); }

    File workspace() {
        File w = new File("/sdcard/cccodroid");
        if (w.isDirectory() || w.mkdirs()) {
            if (w.canWrite()) return w;
        }
        File p = new File(home, "workspace");
        p.mkdirs();
        return p;
    }

    void apply(Map<String, String> e) {
        e.remove("LD_LIBRARY_PATH");
        e.remove("LD_PRELOAD");
        e.put("PREFIX", usr.getPath());
        e.put("HOME", home.getPath());
        e.put("TMPDIR", new File(usr, "tmp").getPath());
        e.put("PATH", usr.getPath() + "/bin:" + new File(app, "bin").getPath() + ":/system/bin:/system/xbin");
        e.put("LANG", "en_US.UTF-8");
        e.put("TERM", "xterm-256color");
        e.put("SHELL", bin("bash").getPath());
        // 网关（server.mjs）认的变量
        e.put("CCAPP_PREFIX", usr.getPath());
        e.put("CCAPP_HOME", home.getPath());
        e.put("CCAPP_RUNTIME", files.getPath());
        e.put("CCAPP_WORKSPACE", workspace().getPath());
        e.put("CCAPP_PORT", String.valueOf(PORT));
        e.put("CCAPP_SHELL", bin("bash").getPath());
        e.put("CCAPP_LOADER", new File(usr, "glibc/lib/ld-linux-aarch64.so.1").getPath());
        e.put("CCAPP_GLIBC_LIB", new File(usr, "glibc/lib").getPath());
        e.put("CCAPP_CLAUDE", claude().getPath());
        e.put("CCAPP_LOG", log.getPath());
        e.put("CCAPP_SEED", new File(home, "seed.json").getPath());
        e.put("CCAPP_BIN", new File(app, "bin").getPath());   // 应用自带的小工具（priv）
    }
}
